// Tests for the provider-independent video generation layer
// (backend/video-generation.js) and its wiring into the job-store
// COMPLETED gate. Run with:
//   node test-video-generation.js
// or:
//   npm run test:video-generation
//
// Covers: a successful full pipeline, a still-pending/processing result, a
// hard failure, and the "no fake completion" case where a provider claims
// completion but doesn't actually hand back a playable video. Also proves
// the default (unconfigured) provider never fabricates a result, and that
// only a real completed videoGeneration result can unlock a job's
// COMPLETED stage — reusing the same job-store gate covered by
// test-completion-gate.js.

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
  await test('the default (unconfigured) provider never fabricates a result', async () => {
    const result = await videoGen.generateVideo({ videoPrompts: ['a shot'], scenes: [], characters: [] });

    assert.strictEqual(result.videoGeneration.provider, 'none');
    assert.strictEqual(result.videoGeneration.status, 'failed');
    assert.ok(result.videoGeneration.error, 'expected an explanatory error message');
    assert.strictEqual(result.finalVideo, undefined, 'no finalVideo may ever be produced with no provider configured');
  });

  await test('submitVideoGeneration failure stops the pipeline with no fabricated status', async () => {
    const provider = fakeProvider({
      async submitVideoGeneration() {
        return { status: 'failed', externalJobId: null, clips: [], error: 'provider rejected the request' };
      },
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['a shot'] }, provider);

    assert.strictEqual(result.videoGeneration.status, 'failed');
    assert.strictEqual(result.videoGeneration.error, 'provider rejected the request');
    assert.strictEqual(result.finalVideo, undefined);
  });

  await test('a still-processing status is reported as pending, not completed', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'processing', clips: [{ id: 'clip-1', status: 'processing' }] };
      },
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['a shot'] }, provider);

    assert.strictEqual(result.videoGeneration.status, 'processing');
    assert.strictEqual(result.videoGeneration.clips.length, 1);
    assert.strictEqual(result.finalVideo, undefined, 'a pending job must never get a finalVideo');
  });

  await test('a completed status without a real retrieved URL is treated as failure, not success', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [{ id: 'clip-1', status: 'completed' }] };
      },
      async retrieveGeneratedVideo() {
        // Provider claims completion but returns no playable video.
        return { status: 'completed', url: null };
      },
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['a shot'] }, provider);

    assert.strictEqual(result.videoGeneration.status, 'failed');
    assert.ok(result.videoGeneration.error, 'expected an explanatory error for the missing playable video');
    assert.strictEqual(result.finalVideo, undefined, 'must never fabricate finalVideo from a claim alone');
  });

  await test('a real completed retrieval with a URL is the only way to get a finalVideo', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [{ id: 'clip-1', url: 'https://example.test/clip-1.mp4', status: 'completed' }] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/final.mp4' };
      },
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['a shot'] }, provider);

    assert.strictEqual(result.videoGeneration.status, 'completed');
    assert.deepStrictEqual(result.finalVideo, { url: 'https://example.test/final.mp4', status: 'completed' });
  });

  await test('a real completed video generation result is what unlocks the job COMPLETED gate', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'https://example.test/final-2.mp4' };
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
      status: 'READY',
      confirmed: true,
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['A pan shot'] }, provider);
    assert.ok(result.finalVideo, 'sanity check: pipeline produced a finalVideo');

    await jobStore.updateJob(job.id, { videoGeneration: result.videoGeneration, finalVideo: result.finalVideo });

    const advanceResult = await jobStore.advanceJob(job.id);

    assert.strictEqual(advanceResult.error, undefined, 'expected advanceJob to succeed once a real video exists');
    assert.strictEqual(advanceResult.job.status, 'COMPLETED');
  });

  await test('an unconfigured video generation attempt still leaves the job blocked at READY', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script:
        'Another short but complete enough script for testing purposes, again well over two ' +
        'hundred characters so it satisfies the SCRIPTING stage gate used throughout this ' +
        'project for validating that a script is not just a truncated fragment.',
      scenes: ['Scene 1'],
      characters: ['Mira'],
      imagePrompts: ['A scene'],
      videoPrompts: ['A pan shot'],
      status: 'READY',
      confirmed: true,
    });

    const result = await videoGen.generateVideo({ videoPrompts: ['A pan shot'] });
    assert.strictEqual(result.finalVideo, undefined);

    await jobStore.updateJob(job.id, { videoGeneration: result.videoGeneration });

    const advanceResult = await jobStore.advanceJob(job.id);

    assert.strictEqual(advanceResult.error, 'missing_required_output');
    assert.ok(advanceResult.missingFields.includes('finalVideo'));
    assert.notStrictEqual(advanceResult.job.status, 'COMPLETED');
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
