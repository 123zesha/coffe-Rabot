// Regression test for the root cause behind the real production failure:
// a job reached ASSET GENERATION with imagePrompts set (and, live, a real
// scene image already generated and persisted) while videoPrompts stayed
// completely empty. Scene video generation then failed safely — zero
// Runway calls were ever made — but only AFTER the scene image had
// already been generated and paid for, and the failure had to be
// diagnosed and repaired by hand rather than by the Agent itself.
//
// imagePrompts[i] and videoPrompts[i] describe the same scene by design
// (see backend/video-generation.js's generateVideoForScenes, which already
// assumes this pairing when matching a video prompt to its scene image).
// The fix — a shared findScenePromptMismatch() check in backend/server.js
// — enforces that pairing BEFORE the very first paid call in the
// pipeline (image generation), not just before the video call, on both
// REST routes (/generate-images, /generate-video). This test exercises
// those two REST routes directly over HTTP (the entry points with no
// existing coverage of this check) to prove:
//   1. /generate-images refuses, with zero OpenAI calls, when videoPrompts
//      is missing or a different length than imagePrompts.
//   2. /generate-video refuses, with zero Runway calls, for the same
//      reason, even when a completed image already exists for the scene.
//   3. The error message is actionable (names updateVideoJob) so the
//      Agent can repair its own data instead of asking the user to.
//   4. Once imagePrompts and videoPrompts are prepared together, matching
//      1:1, image generation proceeds normally (no regression to the
//      normal path).
//
// Uses a local mock OpenAI server and a fake video-generation provider —
// no real OpenAI, Runway, or Anthropic calls, no cost. Run with:
//   node test-scene-prompt-pairing.js
// or:
//   npm run test:scene-prompt-pairing

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

function startMockOpenAi() {
  let requestCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requestCount++;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZWltYWdlZGF0YQ==' }] }));
      });
    });
    server.listen(0, () =>
      resolve({
        server,
        get count() {
          return requestCount;
        },
      })
    );
  });
}

async function main() {
  const mockOpenAi = await startMockOpenAi();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${mockOpenAi.server.address().port}/v1`;

  const videoGeneration = require('./video-generation');
  let submittedPrompts = [];
  videoGeneration.PROVIDERS.fake = {
    name: 'fake',
    async submitVideoGeneration({ prompt }) {
      submittedPrompts.push(prompt);
      return { status: 'processing', externalJobId: 'ext', clips: [] };
    },
    async checkVideoGenerationStatus() {
      return { status: 'completed', clips: [] };
    },
    async retrieveGeneratedVideo() {
      return { status: 'completed', url: 'https://example.test/scene.mp4' };
    },
  };
  process.env.VIDEO_GENERATION_PROVIDER = 'fake';

  const app = require('./server');
  const jobStore = require('./job-store');

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

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  function completedImage(prompt, suffix) {
    return { prompt, url: `data:image/png;base64,${suffix}`, status: 'completed' };
  }

  await test('POST /generate-images refuses with zero OpenAI calls when videoPrompts is missing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { imagePrompts: ['Scene 1: a lighthouse at dusk'] });

    const before = mockOpenAi.count;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-images`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(mockOpenAi.count, before, 'no OpenAI call may happen while videoPrompts is missing');
    assert.ok(body.error.toLowerCase().includes('videoprompts'));
    assert.ok(body.error.toLowerCase().includes('updatevideojob'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.images.length, 0, 'no image may be generated or persisted');
  });

  await test('POST /generate-images refuses when imagePrompts/videoPrompts lengths differ', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1'],
    });

    const before = mockOpenAi.count;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-images`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(mockOpenAi.count, before);
    assert.ok(body.error.includes('2') && body.error.includes('1'));
  });

  await test('POST /generate-images proceeds normally once imagePrompts and videoPrompts match 1:1', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1: a lighthouse at dusk'],
      videoPrompts: ['Slow pan across the lighthouse'],
    });

    const before = mockOpenAi.count;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-images`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(mockOpenAi.count, before + 1, 'exactly one real generation call once prompts are paired');
    assert.strictEqual(body.images[0].status, 'completed');
  });

  await test('POST /generate-video refuses with zero Runway calls when videoPrompts is missing, even with a completed image', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    submittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex: 0 }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(submittedPrompts.length, 0, 'no Runway call may happen while videoPrompts is missing');
    assert.ok(body.error.toLowerCase().includes('videoprompts'));
    assert.ok(body.error.toLowerCase().includes('updatevideojob'));
  });

  await test('POST /generate-video proceeds normally once imagePrompts and videoPrompts match 1:1 (Scene 1 only, sceneIndex 0)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      videoPrompts: ['Slow pan across Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    submittedPrompts = [];
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex: 0 }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.deepStrictEqual(submittedPrompts, ['Slow pan across Scene 1']);
    assert.strictEqual(body.videoGeneration.clips[0].status, 'completed');
  });

  server.close();
  delete videoGeneration.PROVIDERS.fake;
  delete process.env.VIDEO_GENERATION_PROVIDER;
  mockOpenAi.server.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll scene-prompt-pairing tests passed.');
  }
}

main();
