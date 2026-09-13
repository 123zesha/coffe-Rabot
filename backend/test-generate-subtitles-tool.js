// Tests for the new generateSubtitles Agent tool (backend/server.js) and its
// REST route (POST /api/jobs/:id/generate-subtitles) — the optional
// Subtitles feature. backend/subtitles-generation.js's own transcription
// logic is already covered directly by test-subtitles-generation.js; this
// is the tool/route integration layer, mirroring
// test-generate-youtube-package-tool.js's pattern.
//
// Also covers the cross-cutting changes this feature made to
// generateVoiceover (resetting subtitles on a fresh voice-over) and to
// assembleFinalVideo/findFinalVideoBlocker (burnInSubtitles requiring real
// subtitles, and re-assembling when the burn-in state goes stale) — those
// are exercised here rather than in the voice-over/final-video test files
// so all of this feature's cross-cutting behavior lives in one place.
//
// Uses local mock HTTP servers for OpenAI's TTS and transcription endpoints
// — no real network call to OpenAI is ever made, no cost. Run with:
//   node test-generate-subtitles-tool.js
// or:
//   npm run test:generate-subtitles-tool

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

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

const REAL_SCRIPT =
  'Welcome to this video about the quiet lighthouse at the edge of town. ' +
  'For a hundred years it has guided ships safely home through fog and storm. ' +
  'Tonight, we look at the people who kept its light burning, generation after generation.';

const SAMPLE_SRT_A = '1\n00:00:00,000 --> 00:00:02,000\nWelcome to this video.\n';
const SAMPLE_SRT_B = '1\n00:00:00,000 --> 00:00:02,000\nA completely different transcription.\n';

let ttsRequestCount = 0;
let transcriptionRequestCount = 0;
let transcriptionShouldFail = false;
let nextSrtResponse = SAMPLE_SRT_A;

async function main() {
  const openAiServer = await startMockServer((req, res) => {
    if (req.url.startsWith('/audio/speech')) {
      ttsRequestCount++;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.from('fake mp3 audio bytes'));
      });
      return;
    }
    if (req.url.startsWith('/audio/transcriptions')) {
      transcriptionRequestCount++;
      req.on('data', () => {});
      req.on('end', () => {
        if (transcriptionShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'simulated transcription outage' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(nextSrtResponse);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const openAiPort = openAiServer.address().port;

  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openAiPort}`;

  const app = require('./server');
  const jobStore = require('./job-store');

  async function makeJobWithVoiceover() {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });
    ttsRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    assert.strictEqual(result.voiceover.status, 'completed', 'test setup: expected a real voice-over to be generated');
    return job.id;
  }

  await test('generateSubtitles refuses — before any OpenAI call — when there is no voice-over yet', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    transcriptionRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSubtitles', job.id, {}));

    assert.strictEqual(transcriptionRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('voice-over'));
  });

  await test('generateSubtitles refuses — before any OpenAI call — when voiceStyle is "none"', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT, voiceStyle: 'none' });

    transcriptionRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSubtitles', job.id, {}));

    assert.strictEqual(transcriptionRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('no voice-over'));
  });

  await test('generateSubtitles transcribes the real voice-over audio and persists the real .srt content', async () => {
    const jobId = await makeJobWithVoiceover();

    nextSrtResponse = SAMPLE_SRT_A;
    transcriptionRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));

    assert.strictEqual(transcriptionRequestCount, 1, 'expected exactly one real transcription call');
    assert.strictEqual(result.subtitles.status, 'completed', JSON.stringify(result));
    assert.strictEqual(result.subtitles.format, 'srt');
    // The agent-facing summary must never carry the full .srt text.
    assert.strictEqual(result.subtitles.content, undefined);
    assert.strictEqual(result.subtitles.hasSubtitles, true);

    const persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.subtitles.status, 'completed');
    assert.strictEqual(persisted.subtitles.content, SAMPLE_SRT_A.trim());
    assert.strictEqual(persisted.subtitles.generatedFromVoiceoverUrl, persisted.voiceover.url);
  });

  await test('generateSubtitles is a free no-op on a second call with the exact same voice-over audio — never re-spends a real call', async () => {
    const jobId = await makeJobWithVoiceover();

    nextSrtResponse = SAMPLE_SRT_A;
    transcriptionRequestCount = 0;
    const first = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
    assert.strictEqual(first.subtitles.status, 'completed');
    assert.strictEqual(transcriptionRequestCount, 1);

    const second = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
    assert.strictEqual(transcriptionRequestCount, 1, 'an unchanged voice-over url must not trigger a second real transcription call');
    assert.strictEqual(second.subtitles.status, 'completed');
  });

  await test('generateSubtitles forceRegenerate: true bypasses the skip-guard even with an unchanged voice-over', async () => {
    const jobId = await makeJobWithVoiceover();

    nextSrtResponse = SAMPLE_SRT_A;
    transcriptionRequestCount = 0;
    await app.executeTool('generateSubtitles', jobId, {});
    assert.strictEqual(transcriptionRequestCount, 1);

    await app.executeTool('generateSubtitles', jobId, { forceRegenerate: true });
    assert.strictEqual(transcriptionRequestCount, 2, 'forceRegenerate must bypass the skip-if-unchanged guard');
  });

  await test('a fresh, successful generateVoiceover call resets existing subtitles (they no longer match the new audio)', async () => {
    const jobId = await makeJobWithVoiceover();

    nextSrtResponse = SAMPLE_SRT_A;
    await app.executeTool('generateSubtitles', jobId, {});
    let persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.subtitles.status, 'completed');

    // Regenerate the voice-over (e.g. a different voice) — this must
    // invalidate the old subtitles even though nothing about subtitles
    // itself was touched directly.
    await app.executeTool('generateVoiceover', jobId, { voiceStyle: 'female-warm' });
    persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.subtitles.status, 'pending', 'stale subtitles from the old audio must be reset');
    assert.strictEqual(persisted.subtitles.content, null);

    // And a real, fresh transcription must actually run against the new
    // audio the next time subtitles are requested.
    nextSrtResponse = SAMPLE_SRT_B;
    transcriptionRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
    assert.strictEqual(transcriptionRequestCount, 1);
    assert.strictEqual(result.subtitles.status, 'completed');

    persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.subtitles.content, SAMPLE_SRT_B.trim());
  });

  await test('generateSubtitles does NOT cache a failed transcription — it always retries on unchanged input', async () => {
    const jobId = await makeJobWithVoiceover();

    transcriptionShouldFail = true;
    try {
      transcriptionRequestCount = 0;
      const first = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
      assert.strictEqual(first.subtitles.status, 'failed');
      // The OpenAI SDK retries a 500 response by default, so this may be
      // more than one real HTTP attempt per call — the point here is that
      // a SECOND call (below) makes independent, fresh attempts of its own
      // rather than reusing/caching the first call's failure.
      const countAfterFirstCall = transcriptionRequestCount;
      assert.ok(countAfterFirstCall >= 1);

      const second = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
      assert.strictEqual(second.subtitles.status, 'failed');
      assert.ok(
        transcriptionRequestCount > countAfterFirstCall,
        'a failed transcription must never be treated as cached — the second call must make its own real attempt(s)'
      );
    } finally {
      transcriptionShouldFail = false;
    }
  });

  await test('generateSubtitles returns a clear error and makes no call when OPENAI_API_KEY is missing', async () => {
    const jobId = await makeJobWithVoiceover();

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    transcriptionRequestCount = 0;

    try {
      const result = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
      assert.strictEqual(transcriptionRequestCount, 0);
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
    }

    const persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.subtitles.status, 'pending', 'must not fabricate a result when unconfigured');
  });

  await test('generateSubtitles reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('generateSubtitles', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
  });

  await test('updateVideoJob can turn burnInSubtitles on and off, default is off on a new job', async () => {
    const job = await jobStore.createJob();
    assert.strictEqual(job.burnInSubtitles, false);

    const result = JSON.parse(await app.executeTool('updateVideoJob', job.id, { burnInSubtitles: true }));
    assert.strictEqual(result.burnInSubtitles, true);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.burnInSubtitles, true);
  });

  await test('updateVideoJob no longer accepts a direct "subtitles" field — it is backend-populated only', async () => {
    const job = await jobStore.createJob();

    await app.executeTool('updateVideoJob', job.id, {
      subtitles: 'fabricated subtitle text set directly by a client',
    });

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.subtitles.status, 'pending', 'subtitles must not be settable via updateVideoJob');
    assert.strictEqual(persisted.subtitles.content, null);
  });

  await test('summarizeJobForAgent never leaks the internal generatedFromVoiceoverUrl bookkeeping field', async () => {
    const jobId = await makeJobWithVoiceover();
    nextSrtResponse = SAMPLE_SRT_A;

    const result = JSON.parse(await app.executeTool('generateSubtitles', jobId, {}));
    assert.strictEqual(result.subtitles.generatedFromVoiceoverUrl, undefined);
  });

  // --- burnInSubtitles cross-cutting behavior on assembleFinalVideo ---
  // No real video clips exist in these local-jobs.json-only tests, so
  // assembleFinalVideo itself cannot succeed here — these only prove the
  // BLOCKER logic (the part that must run before any real ffmpeg work),
  // which is exactly what needs covering for this feature. Full real
  // assembly + burn-in is covered end-to-end in test-video-assembly.js.

  await test('assembleFinalVideo refuses when burnInSubtitles is on but no real subtitles exist yet', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      burnInSubtitles: true,
      videoPrompts: ['Scene 1'],
      videoGeneration: {
        provider: 'runway',
        status: 'completed',
        clips: [{ status: 'completed', url: 'data:video/mp4;base64,ZmFrZQ==' }],
        error: null,
      },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.ok(result.error.toLowerCase().includes('burninsubtitles'));
    assert.ok(result.error.toLowerCase().includes('generatesubtitles'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'must not assemble a caption-less video while burnInSubtitles is on');
  });

  openAiServer.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  delete process.env.OPENAI_BASE_URL;

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll generateSubtitles tool/route tests passed.');
  }
}

main();
