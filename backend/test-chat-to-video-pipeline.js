// Tests for Chat-to-Video's fully-automatic post-confirmation pipeline —
// server.js's continueChatToVideoPipeline and its REST route
// (POST /api/jobs/:id/continue-pipeline). Covers the sequencing itself
// (voice-over -> subtitles -> final video -> thumbnail/YouTube package,
// one real step per call, exactly like the existing HEAVY_TOOLS/
// assemble-video polling pattern) using small, fast, real local fixtures —
// duration-scale correctness (a real 40-minute video) is covered
// separately and more thoroughly in test-simple-story-video.js and
// test-subtitles-generation.js, so this file exists to prove the
// ORCHESTRATION is correct, not to re-benchmark ffmpeg at scale.
//
// Uses local mock Anthropic/OpenAI servers — no real API call, no cost.
// Run with:
//   node test-chat-to-video-pipeline.js
// or:
//   npm run test:chat-to-video-pipeline

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { execFile } = require('child_process');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || '').toString().slice(-800) || error.message));
      resolve();
    });
  });
}

const REAL_SCRIPT =
  'Once upon a time there was a small lighthouse on a rocky point. Every night the keeper lit the ' +
  'lamp to guide ships safely past the reef. The story of her quiet, steady work became a legend ' +
  'told for generations in the fishing town below.';

const FIXTURE_SRT =
  '1\n00:00:00,000 --> 00:00:02,000\nOnce upon a time.\n\n2\n00:00:02,000 --> 00:00:04,000\nA lighthouse on a rocky point.\n';

const VALID_PACKAGE_JSON = JSON.stringify({
  titles: ['The Lighthouse Keeper', 'A Light in the Fog', 'Guardian of the Reef'],
  description: 'A short story about a lighthouse keeper.',
  tags: ['lighthouse', 'story'],
  thumbnailConcept: 'A glowing lighthouse at dusk.',
  thumbnailText: 'THE LIGHTHOUSE KEEPER',
});

async function main() {
  const simpleStoryVideo = require('./simple-story-video');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-to-video-pipeline-'));
  const fixtureAudioPath = path.join(workDir, 'fixture-voiceover.mp3');
  await runFfmpeg(simpleStoryVideo.ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=4',
    '-c:a',
    'libmp3lame',
    fixtureAudioPath,
  ]);
  const fixtureAudioBuffer = fs.readFileSync(fixtureAudioPath);

  let anthropicRequestCount = 0;
  const anthropicServer = await startMockServer(async (req, res) => {
    anthropicRequestCount++;
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: VALID_PACKAGE_JSON }] }));
  });

  let ttsRequestCount = 0;
  let transcriptionRequestCount = 0;
  let imageRequestCount = 0;
  const openaiServer = await startMockServer(async (req, res) => {
    await readBody(req);
    if (req.url.includes('/audio/speech')) {
      ttsRequestCount++;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(fixtureAudioBuffer);
    } else if (req.url.includes('/audio/transcriptions')) {
      transcriptionRequestCount++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(FIXTURE_SRT);
    } else if (req.url.includes('/images/generations')) {
      imageRequestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZXRodW1ibmFpbA==' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicServer.address().port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openaiServer.address().port}`;

  const server = require('./server');
  const jobStore = require('./job-store');
  const { continueChatToVideoPipeline } = server;

  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  test('continueChatToVideoPipeline reports not_found for an unknown job id', async () => {
    const result = await continueChatToVideoPipeline('no-such-job');
    assert.strictEqual(result.status, 'not_found');
  });

  await test('continueChatToVideoPipeline reports not_applicable for a guided-form job (chatToVideoAutoPipeline false) — never advances it', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT, videoMode: 'simple-story', confirmed: true });
    assert.strictEqual(job.chatToVideoAutoPipeline, false);

    const before = { tts: ttsRequestCount, transcription: transcriptionRequestCount };
    const result = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(result.status, 'not_applicable');
    assert.strictEqual(ttsRequestCount, before.tts, 'a non-auto-pipeline job must never trigger a real call');
    assert.strictEqual(transcriptionRequestCount, before.transcription);
  });

  await test('continueChatToVideoPipeline reports waiting_for_confirmation for an unconfirmed auto-pipeline job', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      videoMode: 'simple-story',
      chatToVideoAutoPipeline: true,
      confirmed: false,
    });

    const before = ttsRequestCount;
    const result = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(result.status, 'waiting_for_confirmation');
    assert.strictEqual(ttsRequestCount, before, 'must never generate anything before the user has confirmed');
  });

  await test('continueChatToVideoPipeline advances voice-over -> subtitles -> final video -> YouTube package, one real step per call, then done', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      videoMode: 'simple-story',
      voiceStyle: 'neutral-narrator',
      chatToVideoAutoPipeline: true,
      generateYoutubePackage: true,
      confirmed: true,
    });

    ttsRequestCount = 0;
    transcriptionRequestCount = 0;
    imageRequestCount = 0;
    anthropicRequestCount = 0;

    const step1 = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(step1.status, 'in_progress');
    assert.strictEqual(step1.step, 'voiceover');
    assert.strictEqual(step1.job.voiceover.status, 'completed');
    assert.strictEqual(ttsRequestCount, 1);
    assert.strictEqual(transcriptionRequestCount, 0, 'subtitles must not run before voice-over completes');

    const step2 = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(step2.status, 'in_progress');
    assert.strictEqual(step2.step, 'subtitles');
    assert.strictEqual(step2.job.subtitles.status, 'completed');
    assert.strictEqual(transcriptionRequestCount, 1);
    assert.strictEqual(step2.job.finalVideo.status, 'pending', 'assembly must not run before subtitles complete');

    const step3 = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(step3.status, 'in_progress');
    assert.strictEqual(step3.step, 'assembly');
    assert.strictEqual(step3.job.finalVideo.status, 'completed', JSON.stringify(step3.job.finalVideo));
    assert.strictEqual(anthropicRequestCount, 0, 'the YouTube package must not run before the final video completes');

    const step4 = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(step4.status, 'done');
    assert.strictEqual(step4.job.youtubePackage.status, 'completed');
    assert.strictEqual(anthropicRequestCount, 1);
    assert.strictEqual(imageRequestCount, 1);

    // Idempotency: calling again after 'done' must never repeat any real,
    // already-successful paid call.
    const before = { tts: ttsRequestCount, transcription: transcriptionRequestCount, anthropic: anthropicRequestCount, image: imageRequestCount };
    const step5 = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(step5.status, 'done');
    assert.strictEqual(ttsRequestCount, before.tts);
    assert.strictEqual(transcriptionRequestCount, before.transcription);
    assert.strictEqual(anthropicRequestCount, before.anthropic);
    assert.strictEqual(imageRequestCount, before.image);
  });

  await test('continueChatToVideoPipeline reports a failed voiceover step honestly when the job has no script, without any real call', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      chatToVideoAutoPipeline: true,
      confirmed: true,
    });

    const before = ttsRequestCount;
    const result = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.step, 'voiceover');
    assert.ok(result.error);
    assert.strictEqual(ttsRequestCount, before);
  });

  await test('POST /api/jobs/:id/continue-pipeline mirrors continueChatToVideoPipeline over HTTP', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      videoMode: 'simple-story',
      voiceStyle: 'neutral-narrator',
      chatToVideoAutoPipeline: true,
      confirmed: true,
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/continue-pipeline`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'in_progress');
    assert.strictEqual(body.step, 'voiceover');
  });

  await test('POST /api/jobs/:id/continue-pipeline returns 404 for an unknown job', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/no-such-job/continue-pipeline`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });

  httpServer.close();
  anthropicServer.close();
  openaiServer.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll Chat-to-Video pipeline tests passed.');
  }
}

main();
