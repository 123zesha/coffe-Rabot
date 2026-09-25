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
const http = require('http');
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

// A local mock OpenAI TTS server (same technique as
// test-generate-voiceover-tool.js) — used only by the "fresh voice-over
// resets in-progress render progress" test below, which needs the real
// generateVoiceover tool to actually succeed (reaching its finalVideo/
// simpleStoryRender reset logic) without ever making a real, paid OpenAI
// call.
function startMockOpenAiTts() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.from('fake mp3 audio bytes'));
      });
    });
    server.listen(0, () => resolve(server));
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

// A second cue starting 46s after the first (past simple-story-video.js's
// own 45s DEFAULT_SECTION_TARGET_SECONDS) forces groupCuesIntoSections to
// produce exactly 2 real sections — used by the resumable-rendering
// integration test below, which needs more than one section to prove a
// resumed call reuses an already-completed one instead of re-rendering it.
const TWO_SECTION_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'Once upon a time there was a curious young fox.',
  '',
  '2',
  '00:00:46,000 --> 00:00:48,000',
  'She loved exploring the forest every morning.',
  '',
].join('\n');

async function makeFixtureVoiceoverDataUri(workDir, durationSeconds = 4) {
  const audioPath = path.join(workDir, `fixture-voiceover-${durationSeconds}.mp3`);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${durationSeconds}`, '-c:a', 'libmp3lame', audioPath]);
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

  // voiceover-generation.js caches its OpenAI client at module load (see
  // its own getClient()), binding it to whatever OPENAI_BASE_URL was set
  // the FIRST time any test actually calls generateVoiceover — a second,
  // later mock server on a different port would be silently ignored (the
  // cached client keeps talking to the first one). So every test in this
  // file that needs a real (mocked, zero-cost) generateVoiceover success
  // shares this ONE mock server/env-var setup for the file's whole
  // lifetime, mirroring test-generate-voiceover-tool.js's own top-level
  // mock server.
  const mockOpenAiServer = await startMockOpenAiTts();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${mockOpenAiServer.address().port}/v1`;

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

  // --- Resumable rendering integration: a real 16+-section story can need
  // more than one assembleFinalVideo call to finish (see
  // simple-story-video.js's own exhaustive tests — including a full
  // 20-section production-shaped end-to-end run — for that underlying
  // mechanism at real scale). This test proves server.js's own
  // orchestration (the Agent tool) correctly surfaces and persists
  // in-progress state and then genuinely resumes from it. It uses a real
  // (downscaled to 2 sections, for test speed) partial render — produced by
  // calling the ORIGINAL continueSimpleStoryVideoAssembly directly with a
  // 1ms time budget so exactly one of its two sections finishes — rather
  // than a fully fabricated one: a fabricated "already completed" section
  // would point at a url with no real file behind it, which the resumed
  // call's final concatenation step would fail to read. Standing in for
  // "a previous call already got partway through" this way keeps the test
  // honest while still exercising server.js's own plumbing, not
  // continueSimpleStoryVideoAssembly's internals again.
  await test('assembleFinalVideo tool surfaces and persists "processing" state, then resumes to completion on the next call', async () => {
    const job = await jobStore.createJob();
    const voiceoverUrl = await makeFixtureVoiceoverDataUri(workDir, 50);

    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
      voiceover: { url: voiceoverUrl, status: 'completed', voice: 'alloy', voiceStyle: 'neutral-narrator' },
      subtitles: {
        status: 'completed',
        format: 'srt',
        content: TWO_SECTION_SRT,
        error: null,
        generatedFromVoiceoverUrl: voiceoverUrl,
      },
    });

    const originalContinueAssembly = simpleStoryVideo.continueSimpleStoryVideoAssembly;
    const realPartialResult = await originalContinueAssembly({
      voiceover: { status: 'completed', url: voiceoverUrl },
      subtitlesContent: TWO_SECTION_SRT,
      existingRender: null,
      jobId: job.id,
      timeBudgetMs: 1,
    });
    assert.strictEqual(realPartialResult.status, 'in_progress', JSON.stringify(realPartialResult));
    assert.strictEqual(realPartialResult.render.totalSections, 2);
    assert.strictEqual(realPartialResult.render.sections.filter((s) => s.status === 'completed').length, 1);
    const section0Url = realPartialResult.render.sections[0].url;
    assert.ok(section0Url, 'expected a real stored url for the already-completed section');

    let realAssemblyCallCount = 0;
    simpleStoryVideo.continueSimpleStoryVideoAssembly = async (args) => {
      realAssemblyCallCount++;
      if (realAssemblyCallCount === 1) {
        return { status: 'in_progress', render: realPartialResult.render };
      }
      // Second call: let the real implementation finish for real, proving
      // the job's persisted state (not the scripted stub) is what actually
      // drives the resumed call forward.
      return originalContinueAssembly(args);
    };

    let realPath;
    let sectionClipPath;
    try {
      const firstResult = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
      assert.strictEqual(firstResult.finalVideo.status, 'processing', JSON.stringify(firstResult));
      assert.strictEqual(firstResult.simpleStoryRender.completedSections, 1);
      assert.strictEqual(firstResult.simpleStoryRender.totalSections, 2);
      assert.strictEqual(firstResult.finalVideo.url, undefined, 'the agent-facing summary must never carry a url while still processing');

      const afterFirst = await jobStore.getJob(job.id);
      assert.strictEqual(afterFirst.finalVideo.status, 'processing');
      assert.strictEqual(afterFirst.simpleStoryRender.status, 'in_progress');
      assert.strictEqual(afterFirst.simpleStoryRender.sections.filter((s) => s.status === 'completed').length, 1);

      // The second call must pass the JOB'S OWN persisted progress as
      // existingRender — proving the real resumption wiring, not just that
      // calling twice happens to work.
      const secondResult = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
      assert.strictEqual(secondResult.finalVideo.status, 'completed', JSON.stringify(secondResult));

      const afterSecond = await jobStore.getJob(job.id);
      assert.strictEqual(afterSecond.simpleStoryRender.status, 'completed');
      // The already-completed section must be reused verbatim, never
      // re-rendered — proven by its storage url staying identical.
      assert.strictEqual(afterSecond.simpleStoryRender.sections[0].url, section0Url);
      realPath = path.join(require('./video-storage').GENERATED_DIR, afterSecond.finalVideo.url.slice('/generated/'.length));
      const probed = await probe(realPath);
      assert.strictEqual(probed.width, 1920);
      assert.strictEqual(probed.height, 1080);
    } finally {
      simpleStoryVideo.continueSimpleStoryVideoAssembly = originalContinueAssembly;
      sectionClipPath = path.join(require('./video-storage').GENERATED_DIR, section0Url.slice('/generated/'.length));
      fs.rmSync(sectionClipPath, { force: true });
      if (realPath) {
        fs.rmSync(realPath, { force: true });
      }
    }
  });

  await test('POST /assemble-video also surfaces and persists "processing" state the same way the Agent tool does', async () => {
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

    const scriptedInProgressRender = {
      status: 'in_progress',
      totalSections: 4,
      sections: [
        { status: 'completed', url: '/generated/fake-section-0.mp4' },
        { status: 'pending', url: null },
        { status: 'pending', url: null },
        { status: 'pending', url: null },
      ],
      audioUrlSnapshot: voiceoverUrl,
      subtitlesContentSnapshot: FIXTURE_SRT,
      error: null,
    };

    const originalContinueAssembly = simpleStoryVideo.continueSimpleStoryVideoAssembly;
    simpleStoryVideo.continueSimpleStoryVideoAssembly = async () => ({ status: 'in_progress', render: scriptedInProgressRender });

    try {
      const res = await fetch(`${baseUrl}/api/jobs/${job.id}/assemble-video`, { method: 'POST' });
      const body = await res.json();

      assert.strictEqual(res.status, 200, JSON.stringify(body));
      assert.strictEqual(body.finalVideo.status, 'processing');
      // The REST route returns the RAW job (like GET /api/jobs/:id) — the
      // full simpleStoryRender record, not the agent's stripped summary.
      assert.strictEqual(body.simpleStoryRender.status, 'in_progress');
      assert.strictEqual(body.simpleStoryRender.sections.filter((s) => s.status === 'completed').length, 1);

      const persisted = await jobStore.getJob(job.id);
      assert.strictEqual(persisted.finalVideo.status, 'processing');
      assert.strictEqual(persisted.simpleStoryRender.totalSections, 4);
    } finally {
      simpleStoryVideo.continueSimpleStoryVideoAssembly = originalContinueAssembly;
    }
  });

  await test('a fresh voice-over resets any in-progress Simple Story Video render progress', async () => {
    const job = await jobStore.createJob();

    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      // findVoiceoverBlocker checks the script's TRIMMED length against
      // MIN_SCRIPT_LENGTH, so trailing whitespace padding (used elsewhere in
      // this file to pad past that minimum for checks that don't trim)
      // does not count here — a real closing sentence is added instead.
      script: LONG_ENOUGH_SCRIPT + ' She always came home before sunset to tell her family everything she had seen.',
      voiceStyle: 'neutral-narrator',
      simpleStoryRender: {
        status: 'in_progress',
        totalSections: 10,
        sections: Array.from({ length: 10 }, (_, i) => (i < 5 ? { status: 'completed', url: `/generated/fake-${i}.mp4` } : { status: 'pending', url: null })),
        audioUrlSnapshot: 'data:audio/mpeg;base64,stale',
        subtitlesContentSnapshot: 'stale subtitles',
        error: null,
      },
    });

    // generateVoiceover only resets simpleStoryRender once the voice-over
    // actually completes, so this needs a real (mocked, zero-cost) success
    // — not just a call that immediately refuses for lack of an API key.
    // Uses the shared mock OpenAI server set up at the top of main().
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    assert.strictEqual(result.error, undefined, `expected generateVoiceover to succeed, got: ${JSON.stringify(result)}`);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.simpleStoryRender.status, 'not_started', 'stale in-progress render state must be reset by a fresh voice-over');
    assert.strictEqual(persisted.simpleStoryRender.sections.length, 0);
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

  // --- Selective video editing (updateVideoEditSettings) ---

  await test('updateVideoEditSettings refuses for a "cinematic" job', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'cinematic' });

    const result = JSON.parse(await app.executeTool('updateVideoEditSettings', job.id, { backgroundColor: '112233' }));
    assert.ok(/cinematic/i.test(result.error), `expected a clear cinematic-mode refusal, got: ${JSON.stringify(result)}`);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoEditSettings.backgroundColor, null, 'a refused call must never partially apply');
  });

  await test('updateVideoEditSettings validates, normalizes, and persists only the fields provided', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const result = JSON.parse(
      await app.executeTool('updateVideoEditSettings', job.id, {
        backgroundColor: '1A2B3C',
        voiceSpeed: 1.5,
      })
    );
    assert.strictEqual(result.error, undefined, JSON.stringify(result));
    assert.strictEqual(result.videoEditSettings.backgroundColor, '1a2b3c');
    assert.strictEqual(result.videoEditSettings.voiceSpeed, 1.5);
    // Untouched fields keep their existing (default) values.
    assert.strictEqual(result.videoEditSettings.subtitleFontScale, 1);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoEditSettings.backgroundColor, '1a2b3c');
    assert.strictEqual(persisted.videoEditSettings.voiceSpeed, 1.5);
  });

  await test('updateVideoEditSettings accepts musicVolumeDb separately from voiceVolumeDb', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const result = JSON.parse(
      await app.executeTool('updateVideoEditSettings', job.id, { voiceVolumeDb: 5, musicVolumeDb: -8 })
    );
    assert.strictEqual(result.error, undefined, JSON.stringify(result));
    assert.strictEqual(result.videoEditSettings.voiceVolumeDb, 5);
    assert.strictEqual(result.videoEditSettings.musicVolumeDb, -8);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoEditSettings.voiceVolumeDb, 5);
    assert.strictEqual(persisted.videoEditSettings.musicVolumeDb, -8);
  });

  await test('updateVideoEditSettings refuses an invalid hex color with a clear, actionable error and changes nothing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story' });

    const result = JSON.parse(await app.executeTool('updateVideoEditSettings', job.id, { backgroundColor: 'sky blue' }));
    assert.ok(/hex/i.test(result.error), `expected a hex-format error, got: ${JSON.stringify(result)}`);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoEditSettings.backgroundColor, null);
  });

  await test('updateVideoEditSettings resets a field back to its default via the "default" sentinel', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoMode: 'simple-story', videoEditSettings: { ...(await jobStore.getJob(job.id)).videoEditSettings, backgroundColor: 'abcdef' } });

    const result = JSON.parse(await app.executeTool('updateVideoEditSettings', job.id, { backgroundColor: 'default' }));
    assert.strictEqual(result.error, undefined, JSON.stringify(result));
    assert.strictEqual(result.videoEditSettings.backgroundColor, null);
  });

  await test('an edit setting change forces a real reassembly; an unchanged one stays a safe no-op', async () => {
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

    const first = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(first.finalVideo.status, 'completed', JSON.stringify(first));
    // job-store.js's no-Redis fallback returns the SAME shared, mutable job
    // object from every getJob call and mutates it in place on update — so
    // a value that must survive a LATER mutation (to compare against) has
    // to be captured as its own primitive right away, not read later off a
    // held object reference (which would silently reflect the later state).
    const firstUrl = (await jobStore.getJob(job.id)).finalVideo.url;
    const firstPath = path.join(require('./video-storage').GENERATED_DIR, firstUrl.slice('/generated/'.length));

    // Unchanged: calling assembleFinalVideo again must be a safe no-op
    // (isFinalVideoStillAccurate returns true), same url.
    const again = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    const againUrl = (await jobStore.getJob(job.id)).finalVideo.url;
    assert.strictEqual(again.finalVideo.status, 'completed');
    assert.strictEqual(againUrl, firstUrl, 'no edit settings changed — must not reassemble');

    // Now change one edit setting — the next assembleFinalVideo call must
    // for real reassemble (a genuinely different url), never keep serving
    // the video built before the edit.
    const editResult = JSON.parse(await app.executeTool('updateVideoEditSettings', job.id, { backgroundColor: '336699' }));
    assert.strictEqual(editResult.error, undefined, JSON.stringify(editResult));

    const second = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(second.finalVideo.status, 'completed', JSON.stringify(second));
    const afterSecond = await jobStore.getJob(job.id);
    const secondUrl = afterSecond.finalVideo.url;
    assert.notStrictEqual(secondUrl, firstUrl, 'an edit settings change must force a real reassembly');
    assert.deepStrictEqual(
      afterSecond.finalVideo.editSettingsUsed,
      require('./simple-story-video').normalizeVideoEditSettings({ backgroundColor: '336699' })
    );

    const secondPath = path.join(require('./video-storage').GENERATED_DIR, secondUrl.slice('/generated/'.length));
    fs.rmSync(firstPath, { force: true });
    fs.rmSync(secondPath, { force: true });
  });

  await test('assembleFinalVideo mixes in real background music for a "simple-story" job when musicEnabled is set, off by default otherwise', async () => {
    const job = await jobStore.createJob();
    const voiceoverUrl = await makeFixtureVoiceoverDataUri(workDir);
    const musicPath = path.join(workDir, 'music-simple-story.mp3');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'libmp3lame', musicPath]);

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

    // Music off (the default) — assembles exactly like every other test
    // above, with musicUsed left null. executeTool returns
    // summarizeJobForAgent's shape (hasMusic, not the raw musicUsed record —
    // see summarizeJobForAgent), so the raw persisted record is checked via
    // jobStore.getJob instead, exactly like finalVideo.url everywhere else
    // in this file.
    const withoutMusic = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(withoutMusic.finalVideo.status, 'completed', JSON.stringify(withoutMusic));
    assert.strictEqual(withoutMusic.finalVideo.hasMusic, false);
    const jobWithoutMusic = await jobStore.getJob(job.id);
    assert.strictEqual(jobWithoutMusic.finalVideo.musicUsed, null);
    const urlWithoutMusic = jobWithoutMusic.finalVideo.url;
    const pathWithoutMusic = path.join(require('./video-storage').GENERATED_DIR, urlWithoutMusic.slice('/generated/'.length));

    // Turning musicEnabled on (musicCustomUrl — a one-off track, bypassing
    // the shared data/music/ library so this test needs no real manifest
    // entry) must force a real reassembly, exactly like an edit-settings
    // change does, and the new video must genuinely have real, mixed-in
    // audio (a real 4s narration+music track, not just the narration alone).
    await jobStore.updateJob(job.id, { musicEnabled: true, musicCustomUrl: musicPath });
    const withMusic = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(withMusic.finalVideo.status, 'completed', JSON.stringify(withMusic));
    assert.strictEqual(withMusic.finalVideo.hasMusic, true);
    assert.deepStrictEqual((await jobStore.getJob(job.id)).finalVideo.musicUsed, { enabled: true, track: null, customUrl: musicPath });

    const afterMusic = await jobStore.getJob(job.id);
    assert.notStrictEqual(afterMusic.finalVideo.url, urlWithoutMusic, 'turning music on must force a real reassembly');
    const pathWithMusic = path.join(require('./video-storage').GENERATED_DIR, afterMusic.finalVideo.url.slice('/generated/'.length));
    const probedWithMusic = await probe(pathWithMusic);
    assert.strictEqual(probedWithMusic.width, 1920);
    assert.strictEqual(probedWithMusic.height, 1080);

    // Calling again unchanged must be a safe no-op (same idempotency
    // guarantee as every other edit-settings/music check for this mode).
    const again = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual((await jobStore.getJob(job.id)).finalVideo.url, afterMusic.finalVideo.url, 'unchanged music settings must not reassemble again');

    fs.rmSync(pathWithoutMusic, { force: true });
    fs.rmSync(pathWithMusic, { force: true });
  });

  // The test above never sets voiceSource — it defaults to 'ai' (see
  // job-store.js) — so it already proves music mixing works for an AI-voice
  // job. This test proves the same for an "Upload My Own Voice" job
  // (voiceSource: 'upload'): music mixing only ever depends on a completed
  // job.voiceover existing, never on how that voice-over was produced, so
  // it must work identically either way.
  await test('assembleFinalVideo mixes in real background music for an "Upload My Own Voice" job just as it does for an AI-voice job', async () => {
    const job = await jobStore.createJob();
    const voiceoverUrl = await makeFixtureVoiceoverDataUri(workDir);
    const musicPath = path.join(workDir, 'music-upload-voice.mp3');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'libmp3lame', musicPath]);

    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      voiceSource: 'upload',
      script: LONG_ENOUGH_SCRIPT + ' '.repeat(200),
      voiceover: { url: voiceoverUrl, status: 'completed', voice: 'uploaded', voiceStyle: '', source: 'upload' },
      subtitles: {
        status: 'completed',
        format: 'srt',
        content: FIXTURE_SRT,
        error: null,
        generatedFromVoiceoverUrl: voiceoverUrl,
      },
      musicEnabled: true,
      musicCustomUrl: musicPath,
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'completed', JSON.stringify(result));
    assert.strictEqual(result.finalVideo.hasMusic, true);

    const persisted = await jobStore.getJob(job.id);
    assert.deepStrictEqual(persisted.finalVideo.musicUsed, { enabled: true, track: null, customUrl: musicPath });
    const realPath = path.join(require('./video-storage').GENERATED_DIR, persisted.finalVideo.url.slice('/generated/'.length));
    const probed = await probe(realPath);
    assert.strictEqual(probed.width, 1920);
    assert.strictEqual(probed.height, 1080);
    fs.rmSync(realPath, { force: true });
  });

  await test('assembleFinalVideo fails clearly for a "simple-story" job when musicTrack names a track that does not exist, without corrupting the job', async () => {
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
      musicEnabled: true,
      musicTrack: 'no-such-track-in-the-manifest',
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'failed');
    assert.ok(result.finalVideo.error, 'an unknown musicTrack must fail with a real, actionable error');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.url, null, 'a failed music resolution must never leave a stale/fabricated finalVideo url');
  });

  await test('a fresh voice-over preserves videoEditSettings (unlike simpleStoryRender/finalVideo, which reset)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoMode: 'simple-story',
      script: LONG_ENOUGH_SCRIPT + ' She always came home before sunset to tell her family everything she had seen.',
      voiceStyle: 'neutral-narrator',
      videoEditSettings: { ...(await jobStore.getJob(job.id)).videoEditSettings, backgroundColor: 'aabbcc', voiceSpeed: 1.2 },
    });

    // Uses the shared mock OpenAI server set up at the top of main().
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    assert.strictEqual(result.error, undefined, JSON.stringify(result));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.videoEditSettings.backgroundColor, 'aabbcc');
    assert.strictEqual(persisted.videoEditSettings.voiceSpeed, 1.2);
    // simpleStoryRender still resets, as proven by the earlier test —
    // this only proves videoEditSettings (a standing style/audio
    // preference, not narration-timing-dependent cache) is untouched.
    assert.strictEqual(persisted.simpleStoryRender.status, 'not_started');
  });

  server.close();
  await new Promise((resolve) => mockOpenAiServer.close(resolve));
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
