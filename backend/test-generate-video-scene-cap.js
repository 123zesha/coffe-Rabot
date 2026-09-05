// Regression test for the TEMPORARY safety cap on
// POST /api/jobs/:id/generate-video (see TEMP_GENERATE_VIDEO_SCENE_CAP in
// server.js): the route must refuse to run unless the job has EXACTLY 2
// video prompts/scenes, and must do so BEFORE ever calling into the video
// generation layer — so a job with 3+ scenes can never trigger even one
// real Runway API call, and a larger job is never silently truncated.
//
// Proves this by monkey-patching video-generation.js's
// generateVideoForScenes — the only function through which a Runway (or
// any other provider) request is ever made — with a call-counting spy, and
// asserting it is never invoked when the scene count is wrong. Uses the
// local data/jobs.json fallback (no Redis) and a real, locally-listening
// instance of the Express app, but makes zero real network calls to
// Runway or any other external service. Run with:
//   node test-generate-video-scene-cap.js
// or:
//   npm run test:generate-video-scene-cap

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;

// job-store.js caches job data in module-level memory after its first read,
// so reset the file to an empty list before requiring anything that pulls
// it in, to guarantee a clean, deterministic starting point.
fs.writeFileSync(JOBS_FILE, '[]\n');

// server.js constructs an Anthropic client at module load time, which
// requires an API key to be present (even though this test never calls
// Claude) — a harmless placeholder is enough.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const videoGeneration = require('./video-generation');

// Spy on the one function that ever reaches a real provider. Patching the
// shared module.exports property (rather than something captured at
// require time) works because server.js looks this property up fresh on
// every call (`videoGeneration.generateVideoForScenes(...)`), not via a
// reference captured once at require time.
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

function completedImage(prompt, suffix) {
  return { prompt, url: `data:image/png;base64,${suffix}`, status: 'completed' };
}

async function main() {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('a job with 3 scenes is refused with zero Runway calls, and is never truncated', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2', 'Scene 3'],
      videoPrompts: ['Pan 1', 'Pan 2', 'Pan 3'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b'), completedImage('Scene 3', 'c')],
    });

    const before = generateVideoForScenesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.ok(body.error.toLowerCase().includes('exactly 2'), 'error message must state the required count');
    assert.strictEqual(body.videoPromptsCount, 3);
    assert.strictEqual(generateVideoForScenesCallCount, before, 'generateVideoForScenes must never be called for a 3-scene job');

    // Confirm the job itself was left untouched — no silent truncation of
    // videoPrompts/imagePrompts/images down to 2, and videoGeneration
    // still shows no attempt was ever made.
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoPrompts.length, 3);
    assert.strictEqual(persisted.imagePrompts.length, 3);
    assert.strictEqual(persisted.images.length, 3);
    assert.strictEqual(persisted.videoGeneration.status, 'not_started');
  });

  await test('a job with 5 scenes is also refused with zero Runway calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['S1', 'S2', 'S3', 'S4', 'S5'],
      videoPrompts: ['P1', 'P2', 'P3', 'P4', 'P5'],
      images: ['S1', 'S2', 'S3', 'S4', 'S5'].map((p, i) => completedImage(p, String(i))),
    });

    const before = generateVideoForScenesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(body.videoPromptsCount, 5);
    assert.strictEqual(generateVideoForScenesCallCount, before, 'generateVideoForScenes must never be called for a 5-scene job');
  });

  await test('a job with only 1 scene is refused with zero Runway calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Only scene'],
      videoPrompts: ['Only pan'],
      images: [completedImage('Only scene', 'a')],
    });

    const before = generateVideoForScenesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(body.videoPromptsCount, 1);
    assert.strictEqual(generateVideoForScenesCallCount, before, 'generateVideoForScenes must never be called for a 1-scene job');
  });

  await test('a job with exactly 2 scenes passes the cap and reaches the video generation layer once', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan 1', 'Pan 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    const before = generateVideoForScenesCallCount;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    await res.json();

    // Not asserting res.status here — with no real provider configured in
    // this test process, the underlying "none" provider fails safely on
    // its own (already covered by test-video-generation.js). This test
    // only proves the cap itself lets an exactly-2-scene job through to
    // the one place a real provider could ever be reached.
    assert.strictEqual(generateVideoForScenesCallCount, before + 1, 'an exactly-2-scene job must reach generateVideoForScenes exactly once');
  });

  server.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll generate-video scene-cap tests passed.');
  }
}

main();
