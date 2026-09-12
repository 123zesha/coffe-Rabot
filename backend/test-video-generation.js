// Tests for the provider-independent video generation layer
// (backend/video-generation.js) and its wiring into the job-store
// COMPLETED gate. Uses fake in-process providers (no real HTTP, no real
// API keys or credits needed) to cover: a successful full pipeline, a
// still-pending/processing result, a hard failure, the "no fake
// completion" case where a provider claims completion but doesn't
// actually hand back a playable clip, retry-safe resumption of an
// already-processing or already-failed clip, per-scene image matching,
// and that a scene failure is logged with its exact error/status and
// never the API secret. Also proves that even when every scene's clip
// completes, finalVideo is never set — only a real (not-yet-built)
// assembly step may ever do that. Run with:
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
const { GENERATED_DIR } = require('./video-storage');

// A stand-in for a real provider's temporary output link — since Runway's
// own docs confirm those expire, video-generation.js now downloads and
// permanently stores whatever a provider hands back the moment a clip
// completes (see backend/video-storage.js), rather than trusting the link
// itself to stay valid. A data: URI lets these tests exercise that real
// download+store step without standing up an HTTP server (video-generation.js
// decodes a data: URI exactly like an http(s) fetch — see downloadClipBytes)
// — no real network call, no cost.
const FAKE_PROVIDER_CLIP_URL = 'data:video/mp4;base64,ZmFrZSBjbGlwIGJ5dGVz';

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
  // Regression test for the real production failure: a real, paid Runway
  // request for Scene 1 was rejected with "HTTP 400: Validation of body
  // failed". Root cause: Runway's image_to_video endpoint, on the API
  // version this integration pins (2024-11-06), rejects the simplified
  // aspect-ratio notation "16:9" — `ratio` must be one of gen4_turbo's
  // literal supported output resolutions (e.g. "1280:720" for 16:9
  // landscape), confirmed by Runway's own Node SDK examples. Pins the
  // fixed default so this can never silently regress back to "16:9".
  await test('DEFAULT_ASPECT_RATIO is a literal Runway-supported resolution, not a reduced ratio string', () => {
    assert.strictEqual(videoGen.DEFAULT_ASPECT_RATIO, '1280:720');
    assert.notStrictEqual(videoGen.DEFAULT_ASPECT_RATIO, '16:9', '"16:9" is rejected by Runway\'s image_to_video validation on API version 2024-11-06');
  });

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

  await test('a real completed retrieval with a URL is downloaded and stored permanently, never left as the provider\'s own link', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });

    const result = await videoGen.generateClip(
      { imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', jobId: 'job-1', sceneIndex: 0 },
      provider
    );

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.stored, true);
    assert.notStrictEqual(result.url, FAKE_PROVIDER_CLIP_URL, 'the provider\'s own link must never be the lasting reference');
    assert.ok(result.url.startsWith('/generated/scene-clip-job-1-0-'), `expected a permanently-stored reference, got: ${result.url}`);
  });

  await test('an already-STORED completed clip is returned unchanged, never re-submitted or re-downloaded', async () => {
    const provider = fakeProvider({
      async submitVideoGeneration() {
        throw new Error('must never be called for an already-completed clip');
      },
      async checkVideoGenerationStatus() {
        throw new Error('must never be called for an already-stored clip');
      },
    });
    const existingClip = {
      status: 'completed',
      externalJobId: 'ext-old',
      url: '/generated/scene-clip-job-1-0-alreadystored.mp4',
      stored: true,
      error: null,
      attempts: 1,
    };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.deepStrictEqual(result, existingClip);
  });

  // Regression coverage for the real production failure: Runway's own docs
  // confirm its task-output link expires within 24-48 hours, even though
  // the underlying video stays retrievable via the same task for up to 14
  // days. A clip completed before permanent storage existed (or whose
  // storage somehow became unreachable) has no `stored: true` — this must
  // heal it via a FREE re-fetch (checkVideoGenerationStatus +
  // retrieveGeneratedVideo on the same externalJobId), never a new
  // submission, and then store the result permanently so it can't happen
  // again.
  await test('a completed-but-not-yet-stored clip is healed via a free re-fetch, never resubmitted', async () => {
    let submitCalls = 0;
    let checkCalls = 0;
    const provider = fakeProvider({
      async submitVideoGeneration() {
        submitCalls++;
        return { status: 'processing', externalJobId: 'should-not-happen', clips: [] };
      },
      async checkVideoGenerationStatus() {
        checkCalls++;
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });
    // No `stored` field — simulates a clip completed before permanent
    // storage existed. Its old url is deliberately unfetchable (like an
    // expired Runway link), forcing the externalJobId recovery path.
    const existingClip = {
      status: 'completed',
      externalJobId: 'ext-legacy',
      url: 'http://localhost:1/expired-link.mp4',
      error: null,
      attempts: 1,
    };

    const result = await videoGen.generateClip(
      { imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip, jobId: 'job-2', sceneIndex: 0 },
      provider
    );

    assert.strictEqual(submitCalls, 0, 'healing a legacy completed clip must never trigger a new (paid) submission');
    assert.strictEqual(checkCalls, 1, 'expected exactly one free status re-check');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.stored, true);
    assert.ok(result.url.startsWith('/generated/scene-clip-job-2-0-'));
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
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });
    const existingClip = { status: 'processing', externalJobId: 'ext-existing', url: null, error: null, attempts: 1 };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.strictEqual(submitCalls, 0, 'a processing clip must never trigger a new submission');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.stored, true);
    assert.strictEqual(result.attempts, 1, 'attempts must not increment on a pure poll');
  });

  await test('a previously failed clip is retried (resubmitted) and attempts increments', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });
    const existingClip = { status: 'failed', externalJobId: null, url: null, error: 'earlier failure', attempts: 1 };

    const result = await videoGen.generateClip({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9', existingClip }, provider);

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.attempts, 2);
  });

  await test('generateVideoForScenes matches each scene to its completed image by position (images[i])', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });

    const result = await videoGen.generateVideoForScenes(
      {
        videoPrompts: ['Slow pan across Mira', 'Boat rocking in waves'],
        images: [
          { prompt: 'Mira at the lighthouse', url: 'data:image/png;base64,mira', status: 'completed' },
          { prompt: 'The boat at sea', url: 'data:image/png;base64,boat', status: 'completed' },
        ],
        existingClips: [],
        jobId: 'job-scenes',
      },
      provider
    );

    assert.strictEqual(result.clips.length, 2);
    assert.ok(result.clips.every((clip) => clip.status === 'completed' && clip.stored === true));
    assert.ok(result.clips[0].url.startsWith('/generated/scene-clip-job-scenes-0-'));
    assert.ok(result.clips[1].url.startsWith('/generated/scene-clip-job-scenes-1-'));
    assert.notStrictEqual(result.clips[0].url, result.clips[1].url, 'each scene must get its own stored clip, not a shared reference');
  });

  // Regression test for the real production failure: Scene 1's image was
  // generated and marked 'completed' in job.images[0], but video
  // generation still reported "No completed scene image is available" —
  // even though the job record listed the image as completed. Root cause:
  // matching was done by exact imagePrompts[i] === image.prompt text
  // equality. updateVideoJob can rewrite imagePrompts text at any time
  // (e.g. while separately fixing a missing videoPrompts entry), but the
  // stored image's .prompt field is frozen at generation time — any later
  // rewording of imagePrompts[i], even one that doesn't change the scene
  // at all, silently orphaned an already-completed, perfectly usable
  // image. Matching by position (images[i]) instead of by prompt text
  // fixes this: the scene's image is found regardless of how imagePrompts
  // has since been reworded.
  await test('generateVideoForScenes still finds the scene image after imagePrompts text has been reworded since generation', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
      },
    });

    const result = await videoGen.generateVideoForScenes(
      {
        // imagePrompts is no longer used for matching at all — this
        // reflects the CURRENT (reworded) prompt, deliberately different
        // from images[0].prompt below, exactly as would happen after an
        // updateVideoJob edit made post-generation.
        imagePrompts: ['Mira stands alone at the lighthouse at dusk, reworded after generation'],
        videoPrompts: ['Slow pan across Mira'],
        images: [{ prompt: 'Mira at the lighthouse', url: 'data:image/png;base64,mira', status: 'completed' }],
        existingClips: [],
        jobId: 'job-reworded',
      },
      provider
    );

    assert.strictEqual(result.clips.length, 1);
    assert.strictEqual(result.clips[0].status, 'completed', 'the completed image must still be found by position, despite the reworded imagePrompts text');
    assert.ok(result.clips[0].url.startsWith('/generated/scene-clip-job-reworded-0-'));
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

  await test('a failed scene is logged with its exact error, scene number, and never the API secret', async () => {
    const provider = fakeProvider({
      async submitVideoGeneration() {
        return { status: 'failed', externalJobId: null, clips: [], error: 'Runway API error (HTTP 401: invalid API key)' };
      },
    });

    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));

    try {
      await videoGen.generateVideoForScenes(
        {
          imagePrompts: ['Scene A', 'Scene B'],
          videoPrompts: ['Pan across A', 'Pan across B'],
          images: [
            { prompt: 'Scene A', url: 'data:image/png;base64,aaa', status: 'completed' },
            { prompt: 'Scene B', url: 'data:image/png;base64,bbb', status: 'completed' },
          ],
          existingClips: [],
        },
        provider
      );
    } finally {
      console.error = originalConsoleError;
    }

    const failureLogs = logged.filter((line) => line.includes('Video clip generation failed'));
    assert.strictEqual(failureLogs.length, 2, 'expected one failure log line per failed scene');

    const scene1Log = JSON.parse(failureLogs[0].replace('Video clip generation failed: ', ''));
    const scene2Log = JSON.parse(failureLogs[1].replace('Video clip generation failed: ', ''));

    assert.strictEqual(scene1Log.scene, 1);
    assert.strictEqual(scene2Log.scene, 2);
    assert.strictEqual(scene1Log.provider, 'fake');
    assert.strictEqual(scene1Log.status, 'failed');
    assert.strictEqual(scene1Log.error, 'Runway API error (HTTP 401: invalid API key)');

    const allLogText = logged.join(' ');
    assert.ok(!allLogText.includes('Bearer'), 'log output must never contain an Authorization header');
    assert.ok(!allLogText.includes('RUNWAYML_API_SECRET'), 'log output must never contain the secret env var value');
    assert.ok(!allLogText.includes('data:image/png;base64,'), 'log output must never contain raw image data');
  });

  await test('every scene clip completing still never sets finalVideo — job stays blocked at READY', async () => {
    const provider = fakeProvider({
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: FAKE_PROVIDER_CLIP_URL };
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

  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });

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
