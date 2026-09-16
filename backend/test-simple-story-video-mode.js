// Regression tests for wiring the "Simple Story Video" mode (job.videoMode
// === 'simple-story') into server.js/job-store.js:
//   1. A job defaults to videoMode 'cinematic' — every existing job's exact
//      pre-existing behavior is untouched.
//   2. A 'simple-story' job can leave ASSET GENERATION without
//      imagePrompts/videoPrompts (job-store.js), while a 'cinematic' job
//      still requires them exactly as before (regression guard).
//   3. generateSceneImages/generateSceneVideo — both the Agent tools AND
//      their equivalent REST routes — refuse outright for a 'simple-story'
//      job, with ZERO calls into the real OpenAI-image/Runway generation
//      functions. This is the concrete proof for "Do not make any paid
//      Runway API calls in this mode": the two functions that are the ONLY
//      way this codebase ever reaches Runway or OpenAI's image API are
//      spied on below, and their call counts are asserted to never move.
//   4. assembleFinalVideo (the Agent tool) end-to-end produces a real,
//      locally-stored 1920x1080 MP4 for a 'simple-story' job using only a
//      local fixture voice-over/subtitles — never a real TTS/transcription
//      call — and correctly skips/detects staleness exactly like the
//      existing Runway pipeline's own idempotency behavior.
//
// Uses the local data/jobs.json fallback (no Redis) and a real, locally-
// listening instance of the Express app, but makes ZERO real network calls
// to Runway, OpenAI, or Anthropic. Run with:
//   node test-simple-story-video-mode.js
// or:
//   npm run test:simple-story-video-mode

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFile } = require('child_process');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;

// job-store.js caches job data in module-level memory after its first read,
// so reset the file to an empty list before requiring anything that pulls
// it in, to guarantee a clean, deterministic starting point.
fs.writeFileSync(JOBS_FILE, '[]\n');

// server.js constructs an Anthropic client at module load time, which
// requires an API key to be present (even though this test never calls
// Claude) — a harmless placeholder is enough, same as the other tests that
// require('./server').
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const imageGeneration = require('./image-generation');
const videoGeneration = require('./video-generation');
const simpleStoryVideo = require('./simple-story-video');

// Spy on the two functions that are the ONLY way this codebase ever reaches
// a real paid image/video-generation provider. Patching the shared
// module.exports property (rather than something captured at require time)
// works because server.js looks these up fresh on every call, not via a
// reference captured once — same technique test-generate-video-scene-cap.js
// already uses for the same reason.
let generateImagesCallCount = 0;
const originalGenerateImagesForPrompts = imageGeneration.generateImagesForPrompts;
imageGeneration.generateImagesForPrompts = async (...args) => {
  generateImagesCallCount++;
  return originalGenerateImagesForPrompts(...args);
};

let generateVideoForScenesCallCount = 0;
const originalGenerateVideoForScenes = videoGeneration.generateVideoForScenes;
videoGeneration.generateVideoForScenes = async (...args) => {
  generateVideoForScenesCallCount++;
  return originalGenerateVideoForScenes(...args);
};

const app = require('./server');
const jobStore = require('./job-store');

let failures = 0;
let server;

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(simpleStoryVideo.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || '').toString().trim().slice(-1000) || error.message));
        return;
      }
      resolve();
    });
  });
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      simpleStoryVideo.ffmpegPath,
      ['-i', filePath, '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 16 },
      (error, stdout, stderr) => {
        const log = (stderr || '').toString();
        const dimensionMatch = log.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (!dimensionMatch) {
          reject(new Error(`Could not probe ${filePath}: ${log.trim().slice(-500)}`));
          return;
        }
        resolve({ width: Number(dimensionMatch[1]), height: Number(dimensionMatch[2]) });
      }
    );
  });
}

const FIXTURE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'Once upon a time there was a curious young fox.',
  '',
  '2',
  '00:00:02,000 --> 00:00:04,000',
  'She loved exploring the forest every morning.',
  '',
].join('\n');

async function makeFixtureVoiceoverDataUri(workDir) {
  const audioPath = path.join(workDir, 'fixture-voiceover.mp3');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'libmp3lame', audioPath]);
  const base64 = fs.readFileSync(audioPath).toString('base64');
  return `data:audio/mpeg;base64,${base64}`;
}

const LONG_ENOUGH_SCRIPT =
  'Once upon a time there was a curious young fox who loved exploring the forest every single morning. ' +
  'She discovered new paths, met new friends, and learned something new every day along the way home.';

async function main() {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-simple-story-mode-'));

  await test('a new job defaults to videoMode "cinematic" (existing behavior fully preserved)', async () => {
    const job = await jobStore.createJob();
    assert.strictEqual(job.videoMode, 'cinematic');
    assert.strictEqual(job.finalVideo.videoModeUsed, null);
  });

  await test('a "simple-story" job can leave ASSET GENERATION with no imagePrompts/videoPrompts', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200), // pad past MIN_SCRIPT_LENGTH
      scenes: ['The forest'],
      characters: ['A young fox'],
      status: 'ASSET GENERATION',
      confirmed: true,
    });

    const result = await jobStore.advanceJob(job.id);
    assert.strictEqual(result.error, undefined, `expected no error, got: ${result.error}`);
    assert.strictEqual(result.job.status, 'EDITING');
  });

  await test('a "cinematic" job still requires imagePrompts/videoPrompts to leave ASSET GENERATION (unchanged)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoMode: 'cinematic',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
      scenes: ['The forest'],
      characters: ['A young fox'],
      status: 'ASSET GENERATION',
      confirmed: true,
    });

    const result = await jobStore.advanceJob(job.id);
    assert.strictEqual(result.error, 'missing_required_output');
    assert.ok(result.missingFields.includes('imagePrompts'));
    assert.ok(result.missingFields.includes('videoPrompts'));
  });

  await test('generateSceneImages tool refuses for a "simple-story" job with zero OpenAI calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const before = generateImagesCallCount;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.ok(/simple story/i.test(result.error), `expected a simple-story-mode refusal, got: ${JSON.stringify(result)}`);
    assert.strictEqual(generateImagesCallCount, before, 'generateImagesForPrompts must never be called');
  });

  await test('generateSceneVideo tool refuses for a "simple-story" job with zero Runway calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const before = generateVideoForScenesCallCount;
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.ok(/simple story/i.test(result.error), `expected a simple-story-mode refusal, got: ${JSON.stringify(result)}`);
    assert.strictEqual(generateVideoForScenesCallCount, before, 'generateVideoForScenes must never be called');
  });

  await test('POST /api/jobs/:id/generate-images refuses for a "simple-story" job with zero OpenAI calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const before = generateImagesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-images`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.ok(/simple story/i.test(body.error));
    assert.strictEqual(generateImagesCallCount, before);
  });

  await test('POST /api/jobs/:id/generate-video refuses for a "simple-story" job with zero Runway calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const before = generateVideoForScenesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.ok(/simple story/i.test(body.error));
    assert.strictEqual(generateVideoForScenesCallCount, before);
  });

  await test('assembleFinalVideo refuses for a "simple-story" job missing voice-over/subtitles', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.ok(/voice-over/i.test(result.error), `expected a voice-over-required error, got: ${JSON.stringify(result)}`);
  });

  await test('assembleFinalVideo produces a real, locally-stored 1920x1080 MP4 for a "simple-story" job — zero paid calls', async () => {
    const job = await jobStore.createJob();
    const voiceoverUrl = await makeFixtureVoiceoverDataUri(workDir);

    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
      voiceover: { url: voiceoverUrl, status: 'completed', voice: 'alloy', voiceStyle: 'neutral-narrator' },
      subtitles: {
        status: 'completed',
        format: 'srt',
        content: FIXTURE_SRT,
        error: null,
        generatedFromVoiceoverUrl: voiceoverUrl,
      },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'completed', JSON.stringify(result));
    assert.strictEqual(result.finalVideo.videoModeUsed, 'simple-story');

    const persisted = await jobStore.getJob(job.id);
    assert.ok(persisted.finalVideo.url, 'expected a real stored url');
    assert.ok(persisted.finalVideo.url.startsWith('/generated/'), 'local dev/test storage must use the /generated/ fallback');

    const videoStorage = require('./video-storage');
    const realPath = path.join(videoStorage.GENERATED_DIR, persisted.finalVideo.url.slice('/generated/'.length));
    const probed = await probe(realPath);
    assert.strictEqual(probed.width, 1920);
    assert.strictEqual(probed.height, 1080);

    // Clean up the real stored file so this test never leaves generated
    // media behind in the repo's data/generated/ directory.
    fs.rmSync(realPath, { force: true });

    // Calling assembleFinalVideo again with nothing changed must be a safe
    // no-op (same idempotency guarantee the Runway pipeline already has) —
    // same url returned, not a fresh reassembly.
    const secondResult = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    const secondPersisted = await jobStore.getJob(job.id);
    assert.strictEqual(secondResult.finalVideo.status, 'completed');
    assert.strictEqual(secondPersisted.finalVideo.url, persisted.finalVideo.url, 'unchanged job must not be reassembled');
  });

  await test('switching videoMode away from "simple-story" after a final video exists correctly invalidates it', async () => {
    const job = await jobStore.createJob();
    const voiceoverUrl = await makeFixtureVoiceoverDataUri(workDir);

    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
      voiceover: { url: voiceoverUrl, status: 'completed', voice: 'alloy', voiceStyle: 'neutral-narrator' },
      subtitles: {
        status: 'completed',
        format: 'srt',
        content: FIXTURE_SRT,
        error: null,
        generatedFromVoiceoverUrl: voiceoverUrl,
      },
    });

    const firstResult = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(firstResult.finalVideo.status, 'completed');
    const afterFirst = await jobStore.getJob(job.id);
    const realPath = path.join(require('./video-storage').GENERATED_DIR, afterFirst.finalVideo.url.slice('/generated/'.length));

    await jobStore.updateJob(job.id, { videoMode: 'cinematic' });
    const afterSwitch = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    // The stale simple-story video must never be silently served as if it
    // were a valid 'cinematic' result — the cinematic pipeline has no scene
    // clips for this job, so it must refuse with a clear reason instead.
    assert.ok(afterSwitch.error, `expected a clear refusal after switching modes, got: ${JSON.stringify(afterSwitch)}`);

    fs.rmSync(realPath, { force: true });
  });

  server.close();
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
    console.log('\nAll simple-story-video mode-wiring tests passed.');
  }
}

main();
