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
    const mockOpenAiServer = await startMockOpenAiTts();
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${mockOpenAiServer.address().port}/v1`;

    try {
      const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
      assert.strictEqual(result.error, undefined, `expected generateVoiceover to succeed, got: ${JSON.stringify(result)}`);

      const persisted = await jobStore.getJob(job.id);
      assert.strictEqual(persisted.simpleStoryRender.status, 'not_started', 'stale in-progress render state must be reset by a fresh voice-over');
      assert.strictEqual(persisted.simpleStoryRender.sections.length, 0);
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      if (originalOpenAiBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
      }
      await new Promise((resolve) => mockOpenAiServer.close(resolve));
    }
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
