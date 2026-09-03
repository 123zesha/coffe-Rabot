// Tests for the provider-independent video generation layer
// (backend/video-generation.js) and its wiring into the job-store
// COMPLETED gate. Uses fake in-process providers (no real HTTP, no real
// API keys or credits needed) to cover: a successful full pipeline, a
// still-pending/processing result, a hard failure, the "no fake
// completion" case where a provider claims completion but doesn't
// actually hand back a playable clip, retry-safe resumption of an
// already-processing or already-failed clip, and per-scene image
// matching. Also proves that even when every scene's clip completes,
// finalVideo is never set — only a real (not-yet-built) assembly step may
// ever do that. Run with:
//   node test-video-generation.js
// or:
//   npm run test:video-generation

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;

// job-store.js caches job data in module-level memory after its first read,
// so reset the file to an empty list before requiring it, to guarantee a
// clean, deterministic starting point for these tests.
fs.writeFileSync(JOBS_FILE, '[]\n');

const jobStore = require('./job-store');
const videoGen = require('./video-generation');

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

async function main() {
  await test('the default (unconfigured "none") provider never fabricates a result', async () => {
    const result = await videoGen.generateClip({
      imageDataUri: 'data:image/png;base64,abc',
      prompt: 'a shot',
      durationSeconds: 5,
      ratio: '16:9',
    });

    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error);
    assert.strictEqual(result.url, null);
  });

  await test('a submit failure stops the pipeline with no fabricated status', async () => {
    const provider = fakeProvider({
      async submitVideoGeneration() {
        return { status: 'failed', externalJobId: null, clips: [], error: 'provider rejected the request' };
      },
    });

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, provider);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'provider rejected the request');
    assert.strictEqual(result.url, null);
    assert.strictEqual(result.attempts, 1);
  });

  await test('a still-processing status is reported as pending, not completed', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'processing', clips: [] };
      },
    });

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, provider);

    assert.strictEqual(result.status, 'processing');
    assert.strictEqual(result.url, null);
  });

  await test('a completed status without a real retrieved URL is treated as failure, not success', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        // Provider claims completion but returns no playable clip.
        return { status: 'completed', url: null };
      },
    });

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, provider);

    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error);
    assert.strictEqual(result.url, null);
  });

  await test('a real completed retrieval with a URL is the only way to get a completed clip', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/clip.mp4' };
      },
    });

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, provider);

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.url, 'https://example.test/clip.mp4');
  });

  await test('an already-completed clip is returned unchanged, never re-submitted', async () => {
    const provider = fakeProvider({
      async submitVideoGeneration() {
        throw new Error('must never be called for an already-completed clip');
      },
    });
    const existingClip = { status: 'completed', externalJobId: 'ext-old', url: 'https://example.test/old.mp4', error: null, attempts: 1 };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.deepStrictEqual(result, existingClip);
  });

  await test('an already-processing clip is only polled, never resubmitted (no double charge)', async () => {
    let submitCalls = 0;
    const provider = fakeProvider({
      async submitVideoGeneration() {
        submitCalls++;
        return { status: 'processing', externalJobId: 'should-not-happen', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/resumed.mp4' };
      },
    });
    const existingClip = { status: 'processing', externalJobId: 'ext-existing', url: null, error: null, attempts: 1 };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.strictEqual(submitCalls, 0, 'a processing clip must never trigger a new submission');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.url, 'https://example.test/resumed.mp4');
    assert.strictEqual(result.attempts, 1, 'attempts must not increment on a pure poll');
  });

  await test('a previously failed clip is retried (resubmitted) and attempts increments', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/retry.mp4' };
      },
    });
    const existingClip = { status: 'failed', externalJobId: null, url: null, error: 'earlier failure', attempts: 1 };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.attempts, 2);
  });

  await test('generateVideoForScenes matches each scene to its completed image by prompt text', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/scene.mp4' };
      },
    });

    const result = await videoGen.generateVideoForScenes(
      {
        imagePrompts: ['Mira at the lighthouse', 'The boat at sea'],
        videoPrompts: ['Slow pan across Mira', 'Boat rocking in waves'],
        images: [
          { prompt: 'Mira at the lighthouse', url: 'data:image/png;base64,mira', status: 'completed' },
          { prompt: 'The boat at sea', url: 'data:image/png;base64,boat', status: 'completed' },
        ],
        existingClips: [],
      },
      provider
    );

    assert.strictEqual(result.clips.length, 2);
    assert.ok(result.clips.every((clip) => clip.status === 'completed' && clip.url === 'https://example.test/scene.mp4'));
  });

  await test('a scene with no completed source image gets a failed clip, never skipped or fabricated', async () => {
    const provider = fakeProvider();

    const result = await videoGen.generateVideoForScenes(
      {
        imagePrompts: ['Scene with no image'],
        videoPrompts: ['A pan shot'],
        images: [],
        existingClips: [],
      },
      provider
    );

    assert.strictEqual(result.clips.length, 1);
    assert.strictEqual(result.clips[0].status, 'failed');
    assert.strictEqual(result.clips[0].url, null);
    assert.ok(result.clips[0].error.includes('image'));
  });

  await test('every scene clip completing still never sets finalVideo — job stays blocked at READY', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/final-scene.mp4' };
      },
    });

    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script:
        'A short but complete enough script for testing purposes here, well over two hundred ' +
        'characters so it counts as a genuinely complete script for the SCRIPTING stage gate ' +
        'validation used elsewhere in this project, just to be safe and thorough.',
      scenes: ['Scene 1'],
      characters: ['Mira'],
      imagePrompts: ['A scene'],
      videoPrompts: ['A pan shot'],
      images: [{ prompt: 'A scene', url: 'data:image/png;base64,abc', status: 'completed' }],
      status: 'READY',
      confirmed: true,
    });

    const result = await videoGen.generateVideoForScenes(
      { imagePrompts: ['A scene'], videoPrompts: ['A pan shot'], images: [{ prompt: 'A scene', url: 'data:image/png;base64,abc', status: 'completed' }], existingClips: [] },
      provider
    );
    assert.ok(result.clips.every((clip) => clip.status === 'completed'), 'sanity check: every clip completed');

    await jobStore.updateJob(job.id, {
      videoGeneration: { provider: 'fake', status: 'completed', clips: result.clips, error: null },
    });

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'finalVideo must never be set from clips alone');

    const advanceResult = await jobStore.advanceJob(job.id);

    assert.strictEqual(advanceResult.error, 'missing_required_output');
    assert.ok(advanceResult.missingFields.includes('finalVideo'));
    assert.notStrictEqual(advanceResult.job.status, 'COMPLETED');
  });

  await test('a real, successfully completed finalVideo (once real assembly exists) is the only thing that allows COMPLETED', async () => {
    // Proves the underlying gate is still a real, working check, unrelated
    // to per-scene clips — exactly the guarantee from the original
    // false-completion fix, still intact after this integration.
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script:
        'Another short but complete enough script for testing, again well over two hundred ' +
        'characters so it satisfies the SCRIPTING stage gate used throughout this project for ' +
        'validating that a script is not just a truncated fragment of real content.',
      scenes: ['Scene 1'],
      characters: ['Mira'],
      imagePrompts: ['A scene'],
      videoPrompts: ['A pan shot'],
      status: 'READY',
      confirmed: true,
      finalVideo: { url: 'https://example.test/assembled-final.mp4', status: 'completed' },
    });

    const result = await jobStore.advanceJob(job.id);

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.job.status, 'COMPLETED');
  });

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll video-generation tests passed.');
  }
}

main();
