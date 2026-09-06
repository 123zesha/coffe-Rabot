// Regression tests for the scene-selection parameter added to the
// video-generation flow (backend/video-generation.js's generateVideoForScenes,
// and the sceneIndex field on POST /api/jobs/:id/generate-video). Purpose:
// let a single, bounded, real test generate Scene 1 only, with every other
// scene (Scene 2 included) structurally guaranteed to never be submitted to
// the provider.
//
// Uses fake in-process providers only — no real HTTP, no real API keys, no
// paid Runway calls. Run with:
//   node test-generate-video-scene-selection.js
// or:
//   npm run test:generate-video-scene-selection

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

function fakeProvider(overrides) {
  return {
    name: 'fake',
    async submitVideoGeneration() {
      return { status: 'processing', externalJobId: 'ext-1', clips: [] };
    },
    async checkVideoGenerationStatus() {
      return { status: 'processing', clips: [] };
    },
    async retrieveGeneratedVideo() {
      return { status: 'failed', url: null, error: 'not reached' };
    },
    ...overrides,
  };
}

function completedImage(prompt, suffix) {
  return { prompt, url: `data:image/png;base64,${suffix}`, status: 'completed' };
}

async function main() {
  await test('sceneIndex 0 submits only Scene 1 to the provider — Scene 2 is never submitted', async () => {
    const submittedPrompts = [];
    const provider = fakeProvider({
      async submitVideoGeneration({ prompt }) {
        submittedPrompts.push(prompt);
        return { status: 'processing', externalJobId: 'ext-scene-1', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/scene-1.mp4' };
      },
    });

    const result = await videoGeneration.generateVideoForScenes(
      {
        imagePrompts: ['Scene 1', 'Scene 2'],
        videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
        images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
        existingClips: [],
        sceneIndex: 0,
      },
      provider
    );

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 1'], 'only Scene 1 must ever be submitted to the provider');
    assert.strictEqual(result.clips.length, 2);
    assert.strictEqual(result.clips[0].status, 'completed');
    assert.strictEqual(result.clips[0].url, 'https://example.test/scene-1.mp4');
    assert.strictEqual(result.clips[1].status, 'not_started', 'Scene 2 must be left completely untouched');
    assert.strictEqual(result.clips[1].externalJobId, null);
    assert.strictEqual(result.clips[1].url, null);
  });

  await test('sceneIndex preserves an untouched scene\'s prior clip state exactly, without retrying it', async () => {
    const submittedPrompts = [];
    const provider = fakeProvider({
      async submitVideoGeneration({ prompt }) {
        submittedPrompts.push(prompt);
        return { status: 'processing', externalJobId: 'ext-scene-1', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/scene-1.mp4' };
      },
    });

    const existingScene2Clip = { status: 'failed', externalJobId: null, url: null, error: 'earlier unrelated failure', attempts: 1 };

    const result = await videoGeneration.generateVideoForScenes(
      {
        imagePrompts: ['Scene 1', 'Scene 2'],
        videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
        images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
        existingClips: [null, existingScene2Clip],
        sceneIndex: 0,
      },
      provider
    );

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 1'], 'Scene 2 must never be resubmitted just because sceneIndex ran');
    assert.deepStrictEqual(result.clips[1], existingScene2Clip, 'an untouched scene\'s existing clip must be carried through unchanged');
  });

  await test('omitting sceneIndex still processes every scene, unchanged from the original behavior', async () => {
    const submittedPrompts = [];
    const provider = fakeProvider({
      async submitVideoGeneration({ prompt }) {
        submittedPrompts.push(prompt);
        return { status: 'processing', externalJobId: 'ext', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/clip.mp4' };
      },
    });

    const result = await videoGeneration.generateVideoForScenes(
      {
        imagePrompts: ['Scene 1', 'Scene 2'],
        videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
        images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
        existingClips: [],
      },
      provider
    );

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 1', 'Pan across Scene 2']);
    assert.ok(result.clips.every((clip) => clip.status === 'completed'));
  });

  // --- Route-level: proves POST /api/jobs/:id/generate-video plumbs
  // sceneIndex through correctly and validates it, on the real Express app.

  const app = require('./server');
  const jobStore = require('./job-store');

  let routeSubmittedPrompts = [];
  videoGeneration.PROVIDERS.fake = fakeProvider({
    async submitVideoGeneration({ prompt }) {
      routeSubmittedPrompts.push(prompt);
      return { status: 'processing', externalJobId: 'ext-route', clips: [] };
    },
    async checkVideoGenerationStatus() {
      return { status: 'completed', clips: [] };
    },
    async retrieveGeneratedVideo() {
      return { status: 'completed', url: 'https://example.test/route-scene.mp4' };
    },
  });
  process.env.VIDEO_GENERATION_PROVIDER = 'fake';

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('POST /generate-video with sceneIndex 0 submits only Scene 1 over HTTP, and the job records Scene 2 as not_started', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    routeSubmittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex: 0 }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.deepStrictEqual(routeSubmittedPrompts, ['Pan across Scene 1'], 'Scene 2 must never reach the provider over HTTP either');
    assert.strictEqual(body.videoGeneration.clips[0].status, 'completed');
    assert.strictEqual(body.videoGeneration.clips[1].status, 'not_started');
    assert.strictEqual(body.videoGeneration.status, 'not_started', 'overall status must not be reported as failed just because Scene 2 was never attempted');
  });

  await test('POST /generate-video rejects an out-of-range sceneIndex with zero provider calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    routeSubmittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex: 5 }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.ok(body.error.toLowerCase().includes('sceneindex'));
    assert.strictEqual(routeSubmittedPrompts.length, 0, 'an invalid sceneIndex must never reach the provider');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoGeneration.status, 'not_started', 'the job must be left untouched');
  });

  await test('POST /generate-video without sceneIndex still submits both scenes, unchanged from existing behavior', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    routeSubmittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.deepStrictEqual(routeSubmittedPrompts, ['Pan across Scene 1', 'Pan across Scene 2']);
    assert.ok(body.videoGeneration.clips.every((clip) => clip.status === 'completed'));
  });

  await test('POST /generate-video allows a genuine single-scene job to generate Scene 1 with sceneIndex 0, bypassing the full-job scene-count cap', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      videoPrompts: ['Pan across Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    routeSubmittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex: 0 }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.deepStrictEqual(routeSubmittedPrompts, ['Pan across Scene 1']);
    assert.strictEqual(body.videoGeneration.clips.length, 1);
    assert.strictEqual(body.videoGeneration.clips[0].status, 'completed');
  });

  server.close();
  delete videoGeneration.PROVIDERS.fake;
  delete process.env.VIDEO_GENERATION_PROVIDER;

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll generate-video scene-selection tests passed.');
  }
}

main();
