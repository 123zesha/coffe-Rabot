// Tests for the new assembleFinalVideo Agent tool AND its matching
// POST /api/jobs/:id/assemble-video REST route (backend/server.js), which
// let the conversational Agent (and the REST API) trigger the real
// ffmpeg-based final-video assembly backend (backend/video-assembly.js) —
// see test-video-assembly.js for the module's own unit tests.
//
// Every scene "video clip" used here is a real, tiny local MP4 this test
// generates itself with ffmpeg (via ffmpeg-static) — no Runway, OpenAI,
// Anthropic, or any other paid API is ever called. Uses the local
// data/jobs.json fallback (no Redis needed). Run with:
//   node test-assemble-final-video.js
// or:
//   npm run test:assemble-final-video

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const app = require('./server');
const jobStore = require('./job-store');
const videoGeneration = require('./video-generation');
const { ffmpegPath, getMediaDuration } = require('./video-assembly');
const { GENERATED_DIR } = require('./video-storage');

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

const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-final-video-fixtures-'));

function makeClip(name) {
  const outPath = path.join(fixturesDir, name);
  execFileSync(
    ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1', '-r', '30', '-pix_fmt', 'yuv420p', outPath],
    { stdio: 'ignore' }
  );
  return outPath;
}

// `stored: true` marks this as already permanently stored (mirrors what
// video-generation.js's ensureClipStored sets once a clip is really
// downloaded and saved) — these tests are about assembleFinalVideo's own
// logic, not about clip-storage healing (see test-video-generation.js and
// test-generate-scene-video-tool.js for that), so the fixture represents a
// clip already ready to assemble, trusted as-is with no extra work.
function completedClip(clipPath) {
  return { status: 'completed', url: clipPath, stored: true, externalJobId: 'ext', error: null, attempts: 1 };
}

function makeAudio(name, durationSeconds) {
  const outPath = path.join(fixturesDir, name);
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`, outPath], {
    stdio: 'ignore',
  });
  return outPath;
}

async function main() {
  const clipPath = makeClip('scene.mp4');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('assembleFinalVideo tool refuses — no ffmpeg run — when there are no scene video clips yet', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoPrompts: ['Scene 1 motion'] });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));

    assert.ok(result.error.toLowerCase().includes('generatescenevideo'));
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'finalVideo must stay untouched');
  });

  await test('assembleFinalVideo tool refuses — naming the exact scene — when one scene clip is still processing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion', 'Scene 2 motion'],
      videoGeneration: {
        provider: 'fake',
        status: 'processing',
        error: null,
        clips: [completedClip(clipPath), { status: 'processing', url: null, externalJobId: 'x', error: null, attempts: 1 }],
      },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));

    assert.ok(result.error.includes('Scene 2'));
    assert.ok(result.error.toLowerCase().includes('processing'));
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'pending');
  });

  await test('assembleFinalVideo tool assembles a real, playable final MP4 once every scene clip is completed', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion'],
      videoGeneration: { provider: 'fake', status: 'completed', error: null, clips: [completedClip(clipPath)] },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));

    assert.strictEqual(result.finalVideo.status, 'completed');
    // summarizeJobForAgent must strip the URL from the conversation, same as
    // every other generated-media field (images, voiceover, video clips).
    assert.strictEqual(result.finalVideo.url, undefined);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'completed');
    // No BLOB_READ_WRITE_TOKEN is set in this test process, so this exercises
    // video-storage.js's local-file fallback: a real MP4 was written to
    // data/generated/ and only a short /generated/... reference is stored on
    // the job — never the video bytes themselves (see
    // test-video-storage.js and the dedicated payload-size test below).
    assert.ok(
      persisted.finalVideo.url && persisted.finalVideo.url.startsWith('/generated/final-video-'),
      `expected a /generated/ reference, got: ${persisted.finalVideo.url}`
    );
    assert.ok(!persisted.finalVideo.url.startsWith('data:'), 'the video bytes must never be embedded in the job record');
  });

  // Regression test for the real, live production failure this fix
  // addresses: assembly failed with "Failed to download media (HTTP 401)"
  // from Runway's own CloudFront/JWT link — confirmed via Runway's own docs
  // to expire within 24-48 hours of the API call that produced it, even
  // though the underlying video stays retrievable via the same task for up
  // to 14 days. A clip completed before permanent clip storage existed (no
  // `stored` field) has exactly this shape: a dead url, but a real,
  // still-usable externalJobId. assembleFinalVideo must heal it via a FREE
  // re-fetch (never a new paid submission) before assembling, and persist
  // the recovery so it never has to happen again for this clip.
  await test('assembleFinalVideo heals a legacy scene clip (dead link, not yet stored) via a free externalJobId re-fetch before assembling', async () => {
    const freshClipDataUri = `data:video/mp4;base64,${fs.readFileSync(clipPath).toString('base64')}`;
    let checkCalls = 0;

    videoGeneration.PROVIDERS.fake = {
      name: 'fake',
      async submitVideoGeneration() {
        throw new Error('must never submit a new (paid) generation to heal an already-completed clip');
      },
      async checkVideoGenerationStatus() {
        checkCalls++;
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: freshClipDataUri };
      },
    };
    process.env.VIDEO_GENERATION_PROVIDER = 'fake';

    try {
      const job = await jobStore.createJob();
      await jobStore.updateJob(job.id, {
        videoPrompts: ['Scene 1 motion'],
        videoGeneration: {
          provider: 'fake',
          status: 'completed',
          error: null,
          // No `stored` field, and a url that can never be downloaded —
          // exactly what a clip completed before this fix looks like once
          // Runway's real link has expired.
          clips: [
            {
              status: 'completed',
              url: 'http://localhost:1/expired-runway-link.mp4',
              externalJobId: 'ext-legacy',
              error: null,
              attempts: 1,
            },
          ],
        },
      });

      const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
      assert.strictEqual(result.finalVideo.status, 'completed', JSON.stringify(result));
      assert.strictEqual(checkCalls, 1, 'expected exactly one free status re-check to heal the legacy clip');

      const persisted = await jobStore.getJob(job.id);
      assert.strictEqual(persisted.videoGeneration.clips[0].stored, true, 'the legacy clip must now be marked permanently stored');
      assert.ok(
        persisted.videoGeneration.clips[0].url.startsWith('/generated/scene-clip-'),
        'the clip must now point at a permanent reference, not the old dead link'
      );
      assert.strictEqual(persisted.finalVideo.status, 'completed');
    } finally {
      delete videoGeneration.PROVIDERS.fake;
      delete process.env.VIDEO_GENERATION_PROVIDER;
    }
  });

  await test('assembleFinalVideo fails with a clear, scene-specific reason when a legacy clip cannot be healed at all', async () => {
    videoGeneration.PROVIDERS.fake = {
      name: 'fake',
      async submitVideoGeneration() {
        throw new Error('must never submit a new (paid) generation');
      },
      async checkVideoGenerationStatus() {
        return { status: 'failed', clips: [], error: 'task no longer exists' };
      },
      async retrieveGeneratedVideo() {
        throw new Error('must never be called once the status re-check already failed');
      },
    };
    process.env.VIDEO_GENERATION_PROVIDER = 'fake';

    try {
      const job = await jobStore.createJob();
      await jobStore.updateJob(job.id, {
        videoPrompts: ['Scene 1 motion'],
        videoGeneration: {
          provider: 'fake',
          status: 'completed',
          error: null,
          clips: [
            {
              status: 'completed',
              url: 'http://localhost:1/expired-runway-link.mp4',
              externalJobId: 'ext-gone',
              error: null,
              attempts: 1,
            },
          ],
        },
      });

      const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
      assert.strictEqual(result.finalVideo.status, 'failed');
      assert.ok(result.finalVideo.error.includes('Scene 1'), `expected the error to name the scene, got: ${result.finalVideo.error}`);
      assert.ok(result.finalVideo.error.toLowerCase().includes('regenerate'));

      const persisted = await jobStore.getJob(job.id);
      assert.strictEqual(
        persisted.videoGeneration.clips[0].status,
        'failed',
        'an unrecoverable legacy clip must be marked failed so the Agent knows to regenerate it'
      );
    } finally {
      delete videoGeneration.PROVIDERS.fake;
      delete process.env.VIDEO_GENERATION_PROVIDER;
    }
  });

  // End-to-end proof (through the real tool + storage, not just the
  // video-assembly.js unit tests) that a job's real, already-generated
  // voice-over actually ends up synchronized into the stored final MP4:
  // every scene's clip is real 1s footage, the voice-over is a real 5s
  // track, so the assembled+stored output must run the full ~5s (proving
  // narration is never truncated) with a real audio stream muxed in.
  await test('assembleFinalVideo tool syncs a real persisted voice-over into the stored final MP4', async () => {
    const voiceoverPath = makeAudio('job-voiceover.mp3', 5);
    const voiceoverDataUri = `data:audio/mpeg;base64,${fs.readFileSync(voiceoverPath).toString('base64')}`;

    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion'],
      videoGeneration: { provider: 'fake', status: 'completed', error: null, clips: [completedClip(clipPath)] },
      voiceover: { url: voiceoverDataUri, status: 'completed', voice: 'alloy', voiceStyle: 'neutral-narrator' },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'completed', JSON.stringify(result));

    const persisted = await jobStore.getJob(job.id);
    const storedPath = path.join(GENERATED_DIR, persisted.finalVideo.url.replace('/generated/', ''));

    const duration = await getMediaDuration(storedPath);
    assert.ok(Math.abs(duration - 5) < 0.5, `expected the stored final video to run the full ~5s voice-over, got ${duration}s`);
  });

  await test('assembleFinalVideo tool skips real work once finalVideo is already completed (no re-assembly)', async () => {
    const job = await jobStore.createJob();
    const placeholderUrl = '/generated/final-video-already-done.mp4';
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion'],
      // Deliberately an unfetchable clip URL — if the tool re-ran assembly
      // instead of skipping, this would make it fail, not silently succeed.
      videoGeneration: {
        provider: 'fake',
        status: 'completed',
        error: null,
        clips: [{ status: 'completed', url: 'http://localhost:1/does-not-exist.mp4', externalJobId: 'x', error: null, attempts: 1 }],
      },
      finalVideo: { url: placeholderUrl, status: 'completed' },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.url, placeholderUrl, 'must not re-run assembly on an already-completed final video');
  });

  await test('assembleFinalVideo tool reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('assembleFinalVideo', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
  });

  // A real, completed finalVideo is exactly what the existing completion
  // gate (job-store.js's STAGE_OUTPUT_REQUIREMENTS.READY) requires before a
  // confirmed job can advance out of READY into COMPLETED — this proves the
  // new assembly step actually closes that gate instead of duplicating its
  // logic, and that a job is never marked COMPLETED without a real
  // finalVideo (see test-completion-gate.js for the gate's own tests).
  await test('a real assembled finalVideo (via the tool) is what finally lets a confirmed job leave READY', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      status: 'READY',
      confirmed: true,
      videoPrompts: ['Scene 1 motion'],
      videoGeneration: { provider: 'fake', status: 'completed', error: null, clips: [completedClip(clipPath)] },
    });

    const blocked = JSON.parse(await app.executeTool('advanceVideoJobStage', job.id, {}));
    assert.ok(blocked.error.toLowerCase().includes('finalvideo') || blocked.error.toLowerCase().includes('final video'));

    await app.executeTool('assembleFinalVideo', job.id, {});

    const advanced = JSON.parse(await app.executeTool('advanceVideoJobStage', job.id, {}));
    assert.strictEqual(advanced.status, 'COMPLETED', JSON.stringify(advanced));
  });

  await test('POST /assemble-video returns 404 for an unknown job', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/does-not-exist/assemble-video`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });

  await test('POST /assemble-video returns 400 with a clear reason when scene clips are not ready', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { videoPrompts: ['Scene 1 motion'] });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/assemble-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.ok(body.error.toLowerCase().includes('generatescenevideo'));
  });

  await test('POST /assemble-video assembles and persists a real final MP4', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion'],
      videoGeneration: { provider: 'fake', status: 'completed', error: null, clips: [completedClip(clipPath)] },
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/assemble-video`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.finalVideo.status, 'completed');
    assert.ok(body.finalVideo.url.startsWith('/generated/final-video-'));
  });

  // Regression test for the exact production risk this storage rework
  // fixes: embedding an assembled video as base64 directly in job.finalVideo
  // (the way images/voiceover already work) grows the job record
  // proportionally to video size, risking the same Redis/Upstash
  // payload-size failure PR #25 fixed. Concatenates several real, several-
  // second clips (a few hundred KB of real MP4 — a genuine multi-scene-sized
  // final video, not a trivial one-frame fixture) and proves the persisted
  // JOB record's own serialized size stays small regardless, because only a
  // short reference URL is ever stored there.
  await test('a real multi-scene final video does not bloat the job record (no Redis/Upstash payload-size risk)', async () => {
    // A moving test pattern (not a flat color) so it doesn't compress down
    // to near-nothing — this needs to be a realistically-sized real video,
    // not just a technically-valid tiny one.
    const biggerClipPath = path.join(fixturesDir, 'bigger-scene.mp4');
    execFileSync(
      ffmpegPath,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=3', '-pix_fmt', 'yuv420p', biggerClipPath],
      { stdio: 'ignore' }
    );

    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      videoPrompts: ['Scene 1 motion', 'Scene 2 motion', 'Scene 3 motion'],
      videoGeneration: {
        provider: 'fake',
        status: 'completed',
        error: null,
        clips: [completedClip(biggerClipPath), completedClip(biggerClipPath), completedClip(biggerClipPath)],
      },
    });

    const result = JSON.parse(await app.executeTool('assembleFinalVideo', job.id, {}));
    assert.strictEqual(result.finalVideo.status, 'completed', JSON.stringify(result));

    const persisted = await jobStore.getJob(job.id);
    const generatedFilePath = path.join(GENERATED_DIR, persisted.finalVideo.url.replace('/generated/', ''));
    const realVideoBytes = fs.statSync(generatedFilePath).size;
    const jobRecordBytes = JSON.stringify(persisted).length;

    assert.ok(realVideoBytes > 50 * 1024, `expected a real multi-second video, only got ${realVideoBytes} bytes`);
    assert.ok(
      jobRecordBytes < 5 * 1024,
      `job record grew to ${jobRecordBytes} bytes for a ${realVideoBytes}-byte video — the video must be stored outside the job record`
    );
  });

  server.close();
  fs.rmSync(fixturesDir, { recursive: true, force: true });
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
    console.log('\nAll assembleFinalVideo tool/route tests passed.');
  }
}

main();
