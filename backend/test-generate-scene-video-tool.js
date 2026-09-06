// Tests for the new generateSceneVideo Agent tool (backend/server.js),
// which lets the conversational Agent trigger the existing, real,
// provider-independent video-generation backend (backend/video-generation.js
// — the same module and logic already used by
// POST /api/jobs/:id/generate-video) for exactly one explicitly selected
// scene, instead of having no video-generation capability at all.
//
// The whole point of sceneIndex is cost control: calling this tool with
// sceneIndex 0 ("Scene 1") must be structurally incapable of ever
// submitting Scene 2 (or any other scene) to the provider. Uses a fake
// in-process provider registered into video-generation.js's PROVIDERS map
// (no real HTTP, no real Runway/OpenAI calls, no cost) and the local
// data/jobs.json fallback (no Redis needed). Calls server.js's executeTool
// directly — exported for exactly this purpose — rather than driving the
// whole /api/agent + Anthropic tool-use loop. Run with:
//   node test-generate-scene-video-tool.js
// or:
//   npm run test:generate-scene-video-tool

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

// server.js constructs an Anthropic client at module load time, which
// requires an API key to be present even though this test never calls
// Claude — a harmless placeholder is enough.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const app = require('./server');
const jobStore = require('./job-store');
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

function completedImage(prompt, suffix) {
  return { prompt, url: `data:image/png;base64,${suffix}`, status: 'completed' };
}

let submittedPrompts = [];
function fakeProvider(overrides) {
  return {
    name: 'fake',
    async submitVideoGeneration({ prompt }) {
      submittedPrompts.push(prompt);
      return { status: 'processing', externalJobId: 'ext-fake', clips: [] };
    },
    async checkVideoGenerationStatus() {
      return { status: 'completed', clips: [] };
    },
    async retrieveGeneratedVideo() {
      return { status: 'completed', url: 'https://example.test/scene.mp4' };
    },
    ...overrides,
  };
}

async function main() {
  videoGeneration.PROVIDERS.fake = fakeProvider();
  process.env.VIDEO_GENERATION_PROVIDER = 'fake';

  await test('generateSceneVideo with sceneIndex 0 submits only Scene 1, and Scene 2 is never submitted', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 1'], 'Scene 2 must never reach the provider');
    assert.strictEqual(result.requestedScene, 0);
    assert.strictEqual(result.sceneResult.status, 'completed');
    assert.ok(!('url' in result.sceneResult), 'the raw clip URL must never be echoed back to the agent');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoGeneration.clips[0].status, 'completed');
    assert.strictEqual(persisted.videoGeneration.clips[0].url, 'https://example.test/scene.mp4');
    assert.strictEqual(persisted.videoGeneration.clips[1].status, 'not_started', 'Scene 2 must be left completely untouched');
    assert.strictEqual(persisted.videoGeneration.status, 'not_started', 'overall status must not read as failed just because Scene 2 was never attempted');
  });

  await test('generateSceneVideo requires sceneIndex — omitting it makes zero provider calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, {}));

    assert.strictEqual(submittedPrompts.length, 0, 'no scene may be submitted without an explicit sceneIndex');
    assert.ok(result.error.toLowerCase().includes('sceneindex'));
  });

  await test('generateSceneVideo rejects an out-of-range sceneIndex with zero provider calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 5 }));

    assert.strictEqual(submittedPrompts.length, 0);
    assert.ok(result.error.toLowerCase().includes('sceneindex'));
  });

  await test('generateSceneVideo does not enforce the full-job scene-count cap, since sceneIndex already bounds this call to one paid request', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2', 'Scene 3'],
      videoPrompts: ['Pan 1', 'Pan 2', 'Pan 3'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b'), completedImage('Scene 3', 'c')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.deepStrictEqual(submittedPrompts, ['Pan 1'], 'a 3-scene job must still allow generating exactly one explicitly selected scene');
    assert.strictEqual(result.sceneResult.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoGeneration.clips[1].status, 'not_started');
    assert.strictEqual(persisted.videoGeneration.clips[2].status, 'not_started');
  });

  await test('generateSceneVideo allows a genuine single-scene job to generate Scene 1 with sceneIndex 0, without needing a fake second scene', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      videoPrompts: ['Pan across Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 1']);
    assert.strictEqual(result.requestedScene, 0);
    assert.strictEqual(result.sceneResult.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoGeneration.clips.length, 1);
    assert.strictEqual(persisted.videoGeneration.clips[0].status, 'completed');
  });

  await test('generateSceneVideo rejects sceneIndex 1 on a genuine single-scene job (out of range), with zero provider calls', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      videoPrompts: ['Pan across Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 1 }));

    assert.strictEqual(submittedPrompts.length, 0);
    assert.ok(result.error.toLowerCase().includes('sceneindex'));
  });

  await test('generateSceneVideo never automatically retries a previously failed scene on its own', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
      videoGeneration: {
        provider: 'fake',
        status: 'failed',
        clips: [
          { status: 'failed', externalJobId: null, url: null, error: 'earlier failure', attempts: 1 },
          { status: 'not_started', externalJobId: null, url: null, error: null, attempts: 0 },
        ],
        error: 'One or more scenes failed to generate a video clip.',
      },
    });

    submittedPrompts = [];
    // Only asking for Scene 2 here — Scene 1's earlier failure must not be
    // auto-retried as a side effect of an unrelated tool call.
    await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 1 });

    assert.deepStrictEqual(submittedPrompts, ['Pan across Scene 2'], 'Scene 1 must not be automatically retried just because Scene 2 was requested');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoGeneration.clips[0].status, 'failed', "Scene 1's earlier failure must be left exactly as it was");
    assert.strictEqual(persisted.videoGeneration.clips[0].attempts, 1);
  });

  // Regression test for the real production failure: Scene 1's image was
  // generated and persisted successfully, but videoPrompts had never been
  // set, so generateSceneVideo failed with "job has no videoPrompts to
  // generate video from" — safe (zero Runway calls) but only discoverable
  // after the image spend had already happened. The shared root-cause
  // check (findScenePromptMismatch) now also guards this tool directly.
  await test('generateSceneVideo refuses — before any Runway call — when videoPrompts is empty even though imagePrompts/images exist', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1'],
      images: [completedImage('Scene 1', 'a')],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.strictEqual(submittedPrompts.length, 0, 'no Runway call may happen while videoPrompts is missing');
    assert.ok(result.error.toLowerCase().includes('videoprompts'));
    assert.ok(result.error.toLowerCase().includes('updatevideojob'), 'the error must tell the Agent how to fix it itself');
  });

  await test('generateSceneVideo returns a clear error and makes no call when there are no completed images yet', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
    });

    submittedPrompts = [];
    const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));

    assert.strictEqual(submittedPrompts.length, 0);
    assert.ok(result.error.toLowerCase().includes('image'));
  });

  await test('generateSceneVideo returns a clear error and makes no call when the active provider is runway with no configured secret', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1', 'Pan across Scene 2'],
      images: [completedImage('Scene 1', 'a'), completedImage('Scene 2', 'b')],
    });

    const originalProvider = process.env.VIDEO_GENERATION_PROVIDER;
    const originalSecret = process.env.RUNWAYML_API_SECRET;
    process.env.VIDEO_GENERATION_PROVIDER = 'runway';
    delete process.env.RUNWAYML_API_SECRET;
    submittedPrompts = [];

    try {
      const result = JSON.parse(await app.executeTool('generateSceneVideo', job.id, { sceneIndex: 0 }));
      assert.strictEqual(submittedPrompts.length, 0, 'no request may reach Runway without a configured secret');
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.VIDEO_GENERATION_PROVIDER = originalProvider;
      if (originalSecret !== undefined) {
        process.env.RUNWAYML_API_SECRET = originalSecret;
      }
    }
  });

  await test('generateSceneVideo reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('generateSceneVideo', 'does-not-exist', { sceneIndex: 0 }));
    assert.strictEqual(result.error, 'job not found');
  });

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
    console.log('\nAll generateSceneVideo tool tests passed.');
  }
}

main();
