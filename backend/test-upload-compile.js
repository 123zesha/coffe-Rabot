// Tests for the "Upload & Compile" flow: job-store.js's 'uploaded-clips'
// VIDEO_MODES entry and its uploadedClips/clipVoiceoverVoice/
// clipVoiceoverBatch/uploadedClipsRender fields, backend/clip-voiceover.js
// (probing + real per-clip voice-over generation), video-assembly.js's
// continueUploadedClipsAssembly (RESUMABLE stitching of uploaded clips in
// order, each keeping its own real/processed audio, plus optional ducked
// background music — resumable because a real multi-clip job can exceed a
// serverless platform's own function-duration ceiling, confirmed live by a
// Vercel deployment killing a single-call assembly after its own 300-second
// limit), cost-estimation.js's estimateClipVoiceoverCost, and server.js's
// POST /api/jobs/upload-compile, POST /:id/upload-clip,
// POST /:id/select-clip-voiceovers, POST /:id/generate-clip-voiceovers, and
// the shared POST /:id/assemble-video route for this mode.
//
// Uses only real local ffmpeg-generated video/audio fixtures and local mock
// Anthropic/OpenAI HTTP servers (the same technique test-reference-video.js
// and test-voiceover-generation.js already use) — no real paid API call, no
// cost. Run with:
//   node test-upload-compile.js
// or:
//   npm run test:upload-compile

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { execFile } = require('child_process');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

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

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || '').toString().slice(-800) || error.message));
      resolve();
    });
  });
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  const simpleStoryVideo = require('./simple-story-video');
  const ffmpegPath = simpleStoryVideo.ffmpegPath;
  const costEstimation = require('./cost-estimation');
  const jobStore = require('./job-store');
  const clipVoiceover = require('./clip-voiceover');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-compile-test-'));

  // A short, SILENT real video clip (color test pattern, no audio stream).
  const silentClipPath = path.join(workDir, 'silent-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentClipPath,
  ]);
  const silentClipBuffer = fs.readFileSync(silentClipPath);

  // A short clip that already HAS its own real audio track.
  const audioClipPath = path.join(workDir, 'audio-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', audioClipPath,
  ]);
  const audioClipBuffer = fs.readFileSync(audioClipPath);

  // ---------------------------------------------------------------------
  // cost-estimation.js: estimateClipVoiceoverCost — pure, no API calls.
  // ---------------------------------------------------------------------

  await test('estimateClipVoiceoverCost is zero for zero selected clips', () => {
    const estimate = costEstimation.estimateClipVoiceoverCost(0);
    assert.strictEqual(estimate.clipCount, 0);
    assert.strictEqual(estimate.totalUsd, 0);
  });

  await test('estimateClipVoiceoverCost scales linearly with the number of selected clips', () => {
    const one = costEstimation.estimateClipVoiceoverCost(1);
    const three = costEstimation.estimateClipVoiceoverCost(3);
    assert.ok(one.totalUsd > 0, 'a single selected clip must have a non-zero estimated cost');
    assert.ok(
      Math.abs(three.totalUsd - one.perClipUsd * 3) < 1e-9,
      'three selected clips must cost exactly three times one clip\'s own per-clip rate'
    );
  });

  // ---------------------------------------------------------------------
  // job-store.js: schema
  // ---------------------------------------------------------------------

  await test("job-store's VIDEO_MODES includes 'uploaded-clips', and a fresh job defaults to no uploaded clips", () => {
    assert.ok(jobStore.VIDEO_MODES.includes('uploaded-clips'));
  });

  // ---------------------------------------------------------------------
  // clip-voiceover.js: probeUploadedClip — real local ffmpeg probing.
  // ---------------------------------------------------------------------

  await test('probeUploadedClip correctly reports hasAudio: false for a real silent clip', async () => {
    const result = await clipVoiceover.probeUploadedClip(silentClipPath);
    assert.strictEqual(result.hasAudio, false);
    assert.ok(result.durationSeconds > 2.5 && result.durationSeconds < 3.5);
  });

  await test('probeUploadedClip correctly reports hasAudio: true for a real clip with its own audio track', async () => {
    const result = await clipVoiceover.probeUploadedClip(audioClipPath);
    assert.strictEqual(result.hasAudio, true);
  });

  // ---------------------------------------------------------------------
  // clip-voiceover.js: generateClipVoiceover end-to-end (mocked Claude
  // vision + mocked OpenAI TTS — no real paid API call).
  // ---------------------------------------------------------------------

  const MOCK_AUDIO_BUFFER = (() => {
    const outPath = path.join(workDir, 'mock-narration.mp3');
    require('child_process').execFileSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.2', '-c:a', 'libmp3lame', outPath,
    ]);
    return fs.readFileSync(outPath);
  })();

  const mockAnthropicServer = await startMockServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'A cheerful character stands beside a bright blue bicycle in a sunny courtyard.' }],
        })
      );
    });
  });
  const mockOpenAiServer = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(MOCK_AUDIO_BUFFER);
    });
  });

  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${mockAnthropicServer.address().port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${mockOpenAiServer.address().port}/v1`;

  await test('generateClipVoiceover produces a completed result with real narration text and a real processed clip', async () => {
    const result = await clipVoiceover.generateClipVoiceover({
      clipUrl: silentClipPath,
      voiceStyle: 'female-warm',
      jobId: 'test-job-1',
      clipId: 'clip-a',
      topic: 'a boy and his bicycle',
    });

    assert.strictEqual(result.status, 'completed', result.error || '');
    assert.ok(result.narrationText && result.narrationText.length > 0);
    assert.ok(result.voiceoverUrl);
    assert.ok(result.processedUrl);

    // The processed clip must be a real, playable file with BOTH a video
    // and an audio stream — the narration must have actually been muxed in,
    // not just generated and discarded.
    const videoAssembly = require('./video-assembly');
    const localPath = result.processedUrl.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, result.processedUrl.slice('/generated/'.length))
      : result.processedUrl;
    const { hasVideoStream, hasAudioStream } = await videoAssembly.probeStreamTypes(localPath);
    assert.strictEqual(hasVideoStream, true);
    assert.strictEqual(hasAudioStream, true);
  });

  // ---------------------------------------------------------------------
  // video-assembly.js: assembleUploadedClipsVideo — real stitching, order
  // preservation, per-clip audio (real or silent), and ducked background
  // music, all verified against real ffmpeg-decoded output.
  // ---------------------------------------------------------------------

  const videoAssembly = require('./video-assembly');

  // How strongly filePath's real decoded audio energy falls within a narrow
  // band around freq during [start, start+duration) — the same technique
  // test-story-to-video.js uses to prove which of several distinctly-toned
  // fixtures is really playing at a given point, never guessed from clip
  // order/filenames alone.
  async function measureBandVolume(filePath, { freq, start, duration }) {
    let output = '';
    await new Promise((resolve) => {
      execFile(
        ffmpegPath,
        [
          '-ss', String(start), '-t', String(duration), '-i', filePath,
          '-af', `bandpass=f=${freq}:width_type=h:w=100,volumedetect`, '-f', 'null', '-',
        ],
        { maxBuffer: 1024 * 1024 * 16 },
        (error, stdout, stderr) => {
          output = (stderr || '').toString();
          resolve();
        }
      );
    });
    const match = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    if (!match) throw new Error(`Could not read mean_volume from ffmpeg output: ${output.slice(-500)}`);
    return Number(match[1]);
  }

  // Plain, full-spectrum mean_volume over [start, start+duration) — unlike
  // measureBandVolume above, this is never narrowed to one frequency band,
  // which matters for the ducking test below (a wide bandpass around music's
  // own frequency can still pick up real energy bleeding in from a nearby,
  // much louder tone's own filter skirts, making a band-limited comparison
  // unreliable right at the edge of real ducking).
  async function measureOverallVolume(filePath, { start, duration }) {
    let output = '';
    await new Promise((resolve) => {
      execFile(
        ffmpegPath,
        ['-ss', String(start), '-t', String(duration), '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
        { maxBuffer: 1024 * 1024 * 16 },
        (error, stdout, stderr) => {
          output = (stderr || '').toString();
          resolve();
        }
      );
    });
    const match = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    if (!match) throw new Error(`Could not read mean_volume from ffmpeg output: ${output.slice(-500)}`);
    return Number(match[1]);
  }

  // Three distinctly-toned/silent 2s clips, assembled in this exact order.
  const toneClipPath = path.join(workDir, 'tone-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', toneClipPath,
  ]);
  const silentMiddleClipPath = path.join(workDir, 'silent-middle-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentMiddleClipPath,
  ]);
  const highToneClipPath = path.join(workDir, 'high-tone-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=900:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', highToneClipPath,
  ]);
  // Two more distinctly-toned 2s clips, used alongside the three above so a
  // 5-clip test can tell EVERY clip's real position apart in the final
  // output (not just "some clips share a tone").
  const midToneClipPath = path.join(workDir, 'mid-tone-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', midToneClipPath,
  ]);
  const highestToneClipPath = path.join(workDir, 'highest-tone-clip.mp4');
  await runFfmpeg(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=1200:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', highestToneClipPath,
  ]);

  // continueUploadedClipsAssembly is RESUMABLE (see its own comment in
  // video-assembly.js) — a real call may return 'in_progress' before every
  // clip is normalized. This helper drives it to completion the same way
  // server.js's own polling loop does, feeding each call's returned
  // `render` into the next one.
  async function runAssemblyToCompletion(args) {
    let render = args.existingRender || null;
    for (let i = 0; i < 50; i++) {
      const result = await videoAssembly.continueUploadedClipsAssembly({ ...args, existingRender: render });
      if (result.status !== 'in_progress') {
        return result;
      }
      render = result.render;
    }
    throw new Error('continueUploadedClipsAssembly never completed after 50 calls');
  }

  await test('continueUploadedClipsAssembly stitches clips in the given order, each keeping its own real/silent audio', async () => {
    const result = await runAssemblyToCompletion({
      uploadedClips: [
        { id: '1', url: toneClipPath, processedUrl: null },
        { id: '2', url: silentMiddleClipPath, processedUrl: null },
        { id: '3', url: highToneClipPath, processedUrl: null },
      ],
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-order',
    });
    assert.strictEqual(result.status, 'completed', result.error || '');
    assert.strictEqual(result.render.status, 'completed');
    assert.strictEqual(result.render.normalizedClips.length, 3);

    const outPath = path.join(workDir, 'assembled-order-check.mp4');
    fs.writeFileSync(outPath, result.buffer);

    const duration = await videoAssembly.getMediaDuration(outPath);
    assert.ok(duration > 5.7 && duration < 6.3, `expected ~6s total, got ${duration}`);

    const vol300AtStart = await measureBandVolume(outPath, { freq: 300, start: 0.2, duration: 1.4 });
    const vol900AtStart = await measureBandVolume(outPath, { freq: 900, start: 0.2, duration: 1.4 });
    assert.ok(vol300AtStart > vol900AtStart + 10, 'the first segment must carry clip 1\'s own 300Hz tone, not clip 3\'s');

    const vol900AtEnd = await measureBandVolume(outPath, { freq: 900, start: 4.2, duration: 1.4 });
    const vol300AtEnd = await measureBandVolume(outPath, { freq: 300, start: 4.2, duration: 1.4 });
    assert.ok(vol900AtEnd > vol300AtEnd + 10, 'the last segment must carry clip 3\'s own 900Hz tone, in its real uploaded order');

    const middleVolume = await measureBandVolume(outPath, { freq: 300, start: 2.2, duration: 1.4 });
    assert.ok(
      middleVolume < vol300AtStart - 10,
      "the silent clip's own segment must be real silence, never another clip's audio leaking in"
    );
  });

  const musicTrackPath = path.join(workDir, 'music-track.mp3');
  await runFfmpeg(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=150:duration=10', '-c:a', 'libmp3lame', musicTrackPath]);

  await test('continueUploadedClipsAssembly mixes in background music, automatically ducked under non-silent clip audio', async () => {
    const twoClips = [
      { id: '1', url: toneClipPath, processedUrl: null },
      { id: '2', url: silentMiddleClipPath, processedUrl: null },
    ];

    const baseline = await runAssemblyToCompletion({ uploadedClips: twoClips, musicUrl: null, resolutionTier: '720p', jobId: 'test-job-music-a' });
    assert.strictEqual(baseline.status, 'completed', baseline.error || '');
    const baselinePath = path.join(workDir, 'assembled-no-music.mp4');
    fs.writeFileSync(baselinePath, baseline.buffer);

    const withMusic = await runAssemblyToCompletion({
      uploadedClips: twoClips,
      musicUrl: musicTrackPath,
      resolutionTier: '720p',
      jobId: 'test-job-music-b',
    });
    assert.strictEqual(withMusic.status, 'completed', withMusic.error || '');
    const withMusicPath = path.join(workDir, 'assembled-with-music.mp4');
    fs.writeFileSync(withMusicPath, withMusic.buffer);

    // Clip 2's segment is real digital silence with no music — adding music
    // must make it audibly louder there, since there's nothing to duck
    // under.
    const silenceBaseline = await measureOverallVolume(baselinePath, { start: 2.2, duration: 1.4 });
    const silenceWithMusic = await measureOverallVolume(withMusicPath, { start: 2.2, duration: 1.4 });
    assert.ok(
      silenceWithMusic > silenceBaseline + 15,
      `expected music to clearly fill clip 2's silent segment (baseline ${silenceBaseline}dB, with music ${silenceWithMusic}dB)`
    );

    // Clip 1's segment has real tone "speech" — sidechaincompress must duck
    // the music down there, so the mixed result stays close to the tone's
    // own original loudness rather than being swamped by full-volume music
    // layered on top of it.
    const toneBaseline = await measureOverallVolume(baselinePath, { start: 0.2, duration: 1.4 });
    const toneWithMusic = await measureOverallVolume(withMusicPath, { start: 0.2, duration: 1.4 });
    assert.ok(
      toneWithMusic < toneBaseline + 6,
      `expected music to be ducked down under clip 1's own audio (baseline ${toneBaseline}dB, with music ${toneWithMusic}dB) — ` +
        'automatic ducking does not appear to be working'
    );
  });

  // ---------------------------------------------------------------------
  // continueUploadedClipsAssembly: RESUMABLE across calls (the real fix for
  // the production bug — a real multi-clip job can exceed a serverless
  // platform's own function-duration ceiling; confirmed live by a Vercel
  // deployment killing a single-call assembly after its own 300-second
  // limit) and staleness detection when the clip set changes mid-render.
  // ---------------------------------------------------------------------

  await test('continueUploadedClipsAssembly stops at the time budget and resumes on a later call without re-normalizing finished clips', async () => {
    // More clips than CLIP_NORMALIZE_CONCURRENCY (4): mapWithConcurrencyUntilDeadline
    // always starts one item per worker slot regardless of the deadline, so
    // with only 3 clips every one of them would start immediately even with
    // a near-zero budget. 5 clips guarantees at least the 5th must wait for
    // a worker to free up — by which point the tiny budget has already
    // passed — forcing a real, partial 'in_progress' result.
    const clips = [
      { id: '1', url: toneClipPath, processedUrl: null },
      { id: '2', url: silentMiddleClipPath, processedUrl: null },
      { id: '3', url: highToneClipPath, processedUrl: null },
      { id: '4', url: toneClipPath, processedUrl: null },
      { id: '5', url: silentMiddleClipPath, processedUrl: null },
    ];

    const first = await videoAssembly.continueUploadedClipsAssembly({
      uploadedClips: clips,
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-resume',
      existingRender: null,
      timeBudgetMs: 1,
    });
    assert.strictEqual(first.status, 'in_progress');
    const completedAfterFirst = first.render.normalizedClips.filter((c) => c.status === 'completed').length;
    assert.ok(completedAfterFirst >= 1 && completedAfterFirst < 5, `expected partial progress, got ${completedAfterFirst}/5`);
    const urlsAfterFirst = first.render.normalizedClips.map((c) => c.url);

    const final = await runAssemblyToCompletion({
      uploadedClips: clips,
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-resume',
      existingRender: first.render,
    });
    assert.strictEqual(final.status, 'completed');

    // Every clip that was already completed after the first call must keep
    // the EXACT SAME stored url after resuming — proof it was never
    // re-normalized, not just that the end result happens to look right.
    first.render.normalizedClips.forEach((clip, i) => {
      if (clip.status === 'completed') {
        assert.strictEqual(final.render.normalizedClips[i].url, urlsAfterFirst[i], `clip ${i} must not be re-normalized on resume`);
      }
    });
  });

  // The test above only confirms resuming never RE-normalizes an
  // already-completed clip — it never checks that the real, final
  // concatenated OUTPUT still plays back in the right order once several
  // clips (more than CLIP_NORMALIZE_CONCURRENCY) had to be normalized
  // across MULTIPLE resumable calls, which is exactly the shape a real
  // production job with many real-sized clips takes (a real multi-clip
  // job can't finish normalizing in one call — see
  // CLIP_ASSEMBLY_TIME_BUDGET_MS's own comment). Five DISTINCT real
  // signatures (never two clips sharing one) make every position in the
  // real output individually verifiable.
  await test('continueUploadedClipsAssembly keeps the given order correct in the real output, even after resuming across several calls', async () => {
    const clips = [
      { id: '1', url: toneClipPath, processedUrl: null }, // 300Hz
      { id: '2', url: midToneClipPath, processedUrl: null }, // 500Hz
      { id: '3', url: silentMiddleClipPath, processedUrl: null }, // silence
      { id: '4', url: highToneClipPath, processedUrl: null }, // 900Hz
      { id: '5', url: highestToneClipPath, processedUrl: null }, // 1200Hz
    ];

    const result = await runAssemblyToCompletion({
      uploadedClips: clips,
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-resume-order',
      timeBudgetMs: 1,
    });
    assert.strictEqual(result.status, 'completed', result.error || '');

    const outPath = path.join(workDir, 'assembled-resume-order-check.mp4');
    fs.writeFileSync(outPath, result.buffer);

    const windows = [
      { label: '1 (300Hz)', start: 0.2, expectFreq: 300, otherFreq: 1200 },
      { label: '2 (500Hz)', start: 2.2, expectFreq: 500, otherFreq: 1200 },
      { label: '4 (900Hz)', start: 6.2, expectFreq: 900, otherFreq: 300 },
      { label: '5 (1200Hz)', start: 8.2, expectFreq: 1200, otherFreq: 300 },
    ];
    for (const { label, start, expectFreq, otherFreq } of windows) {
      const expectVol = await measureBandVolume(outPath, { freq: expectFreq, start, duration: 1.4 });
      const otherVol = await measureBandVolume(outPath, { freq: otherFreq, start, duration: 1.4 });
      assert.ok(
        expectVol > otherVol + 10,
        `segment for clip ${label} at ${start}s must carry its own real tone — got ${expectFreq}Hz=${expectVol}dB vs ${otherFreq}Hz=${otherVol}dB`
      );
    }
  });

  await test('continueUploadedClipsAssembly discards stale progress and starts over when the clip set actually changes', async () => {
    const originalClips = [{ id: '1', url: toneClipPath, processedUrl: null }];
    const first = await runAssemblyToCompletion({
      uploadedClips: originalClips,
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-stale',
    });
    assert.strictEqual(first.status, 'completed');

    const changedClips = [
      { id: '1', url: toneClipPath, processedUrl: null },
      { id: '2', url: silentMiddleClipPath, processedUrl: null },
    ];
    const second = await videoAssembly.continueUploadedClipsAssembly({
      uploadedClips: changedClips,
      musicUrl: null,
      resolutionTier: '720p',
      jobId: 'test-job-stale',
      existingRender: first.render,
    });
    // A real, different clip set must never reuse the old 1-clip progress
    // record — it must restart fresh, now sized for 2 clips.
    assert.strictEqual(second.render.normalizedClips.length, 2);
  });

  // ---------------------------------------------------------------------
  // server.js REST routes: full "select -> cost -> confirm -> generate"
  // flow, and the "never touch other flows/unselected clips" guarantees.
  // ---------------------------------------------------------------------

  const server = require('./server');
  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  await test('POST /api/jobs/upload-compile creates a job already in uploaded-clips mode', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.job.videoMode, 'uploaded-clips');
    assert.deepStrictEqual(body.job.uploadedClips, []);
  });

  await test('POST /:id/upload-clip rejects an unsupported content type', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const job = (await createRes.json()).job;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not a video',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.toLowerCase().includes('unsupported'));
  });

  await test('POST /:id/upload-clip refuses on a job that is not in uploaded-clips mode', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs`, { method: 'POST' });
    const job = await createRes.json();
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });
    assert.strictEqual(res.status, 400);
  });

  let compileJobId;
  let silentClipId;
  let audioClipId;

  await test('POST /:id/upload-clip stores the clip and honestly reports hasAudio for each real file', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    compileJobId = (await createRes.json()).job.id;

    const res1 = await fetch(`${baseUrl}/api/jobs/${compileJobId}/upload-clip?filename=silent.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.strictEqual(body1.clip.hasAudio, false);
    assert.strictEqual(body1.clip.sourceFilename, 'silent.mp4');
    silentClipId = body1.clip.id;

    const res2 = await fetch(`${baseUrl}/api/jobs/${compileJobId}/upload-clip?filename=audio.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: audioClipBuffer,
    });
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json();
    assert.strictEqual(body2.clip.hasAudio, true);
    audioClipId = body2.clip.id;

    assert.strictEqual(body2.job.uploadedClips.length, 2);
  });

  // ---------------------------------------------------------------------
  // POST /:id/upload-clip — multi-part upload (a real clip exceeding a
  // serverless platform's own per-request body-size ceiling, confirmed
  // live by a real ~10MB clip failing to upload in one request).
  // ---------------------------------------------------------------------

  await test('POST /:id/upload-clip requires clientKey when totalParts > 1', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/upload-clip?partIndex=1&totalParts=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: audioClipBuffer.subarray(0, 100),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /:id/upload-clip refuses a later part when the previous part was never uploaded', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;
    const res = await fetch(
      `${baseUrl}/api/jobs/${jobId}/upload-clip?partIndex=2&totalParts=2&clientKey=missing-first-part`,
      { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: audioClipBuffer.subarray(0, 100) }
    );
    assert.strictEqual(res.status, 400);
  });

  await test('POST /:id/upload-clip reassembles a clip uploaded in several small parts, byte-for-byte correct', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    const CHUNK_SIZE = 12 * 1024; // artificially small, to force several real parts
    const totalParts = Math.ceil(audioClipBuffer.length / CHUNK_SIZE);
    assert.ok(totalParts >= 3, 'the fixture must be large enough to exercise at least 3 real parts');
    const clientKey = 'test-client-key-1';

    let finalBody;
    for (let partIndex = 1; partIndex <= totalParts; partIndex++) {
      const start = (partIndex - 1) * CHUNK_SIZE;
      const chunk = audioClipBuffer.subarray(start, start + CHUNK_SIZE);
      const res = await fetch(
        `${baseUrl}/api/jobs/${jobId}/upload-clip?filename=big.mp4&partIndex=${partIndex}&totalParts=${totalParts}&clientKey=${clientKey}`,
        { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: chunk }
      );
      assert.strictEqual(res.status, 200, `part ${partIndex} of ${totalParts} failed`);
      finalBody = await res.json();
      if (partIndex < totalParts) {
        assert.strictEqual(finalBody.partIndex, partIndex);
        assert.ok(!finalBody.clip, 'an intermediate part must not yet produce a finished clip');
      }
    }

    assert.ok(finalBody.clip, 'the last part must produce a finished clip');
    assert.strictEqual(finalBody.clip.hasAudio, true);
    assert.deepStrictEqual(finalBody.job.pendingClipUploads, {}, 'pending bookkeeping must be cleared once the clip completes');

    // Byte-for-byte reassembly check: the stored clip's real duration must
    // match the original, unchunked file's own real duration exactly.
    const expectedDuration = await videoAssembly.getMediaDuration(audioClipPath);
    const localPath = finalBody.clip.url.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, finalBody.clip.url.slice('/generated/'.length))
      : finalBody.clip.url;
    const actualDuration = await videoAssembly.getMediaDuration(localPath);
    assert.ok(Math.abs(actualDuration - expectedDuration) < 0.05, `expected duration ${expectedDuration}, got ${actualDuration}`);
  });

  // ---------------------------------------------------------------------
  // Scene-number ordering: server.js's parseSceneNumberFromFilename /
  // computeAutoClipOrder (auto-sort uploadedClips while unambiguous) and
  // POST /:id/reorder-uploaded-clips (manual override, once and for all).
  // ---------------------------------------------------------------------

  async function uploadClip(jobId, filename) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/upload-clip?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });
    assert.strictEqual(res.status, 200, `upload of ${filename} failed`);
    return res.json();
  }

  await test('parseSceneNumberFromFilename reads the scene number out of common filename shapes', () => {
    assert.strictEqual(server.parseSceneNumberFromFilename('scene_01.mp4'), 1);
    assert.strictEqual(server.parseSceneNumberFromFilename('Scene-2.mov'), 2);
    assert.strictEqual(server.parseSceneNumberFromFilename('SCENE 03.webm'), 3);
    assert.strictEqual(server.parseSceneNumberFromFilename('myscene10.mp4'), 10);
    assert.strictEqual(server.parseSceneNumberFromFilename('intro.mp4'), null);
    assert.strictEqual(server.parseSceneNumberFromFilename(null), null);
  });

  // Regression for a real production job: 20 clips named plainly "1.mp4"
  // through "20.mp4" (no "scene" keyword) came back in the wrong order
  // because the browser's own file-picker order wasn't numeric, and the
  // old parser only recognized "scene_XX" filenames, so it fell back to
  // that wrong upload order instead of auto-sorting.
  await test('parseSceneNumberFromFilename also reads a filename that is ENTIRELY a number', () => {
    assert.strictEqual(server.parseSceneNumberFromFilename('1.mp4'), 1);
    assert.strictEqual(server.parseSceneNumberFromFilename('07.mp4'), 7);
    assert.strictEqual(server.parseSceneNumberFromFilename('20.mp4'), 20);
    assert.strictEqual(server.parseSceneNumberFromFilename('clip 5.mp4'), null, 'must not match when anything besides the number is present');
    assert.strictEqual(server.parseSceneNumberFromFilename('my.video.20.mp4'), null, 'must not match when the number is not the whole basename');
  });

  // Regression for a second real production job: an export tool named the
  // clips "1_20261004173834.mp4", "2_20261004173834.mp4", ... (scene number,
  // then an underscore, then a generation timestamp) — not ENTIRELY a
  // number, so the bare-numeric check above correctly didn't match it, and
  // the job fell back to ambiguous upload order yet again.
  await test('parseSceneNumberFromFilename reads the leading number when it is followed by "_" or "-" and more text', () => {
    assert.strictEqual(server.parseSceneNumberFromFilename('1_20261004173834.mp4'), 1);
    assert.strictEqual(server.parseSceneNumberFromFilename('2_20261004173834.mp4'), 2);
    assert.strictEqual(server.parseSceneNumberFromFilename('20_20261004173835.mp4'), 20);
    assert.strictEqual(server.parseSceneNumberFromFilename('07-final-export.mov'), 7);
    assert.strictEqual(server.parseSceneNumberFromFilename('IMG_0012.mp4'), null, 'must not match when the leading text is not itself a number');
  });

  await test('computeAutoClipOrder sorts by scene number when every clip has one, and is null when ambiguous', () => {
    const sorted = server.computeAutoClipOrder([
      { id: 'a', sourceFilename: 'scene_03.mp4' },
      { id: 'b', sourceFilename: 'scene_01.mp4' },
      { id: 'c', sourceFilename: 'scene_02.mp4' },
    ]);
    assert.deepStrictEqual(sorted.map((clip) => clip.id), ['b', 'c', 'a']);

    assert.strictEqual(
      server.computeAutoClipOrder([{ id: 'a', sourceFilename: 'scene_01.mp4' }, { id: 'b', sourceFilename: 'clip.mp4' }]),
      null,
      'a clip with no parseable scene number must make the whole order ambiguous'
    );
    assert.strictEqual(
      server.computeAutoClipOrder([
        { id: 'a', sourceFilename: 'scene_01.mp4' },
        { id: 'b', sourceFilename: 'scene_01.mp4' },
      ]),
      null,
      'two clips sharing the same scene number must make the whole order ambiguous'
    );
  });

  await test('POST /:id/upload-clip auto-sorts uploaded clips by scene number regardless of upload order', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    await uploadClip(jobId, 'scene_03.mp4');
    await uploadClip(jobId, 'scene_01.mp4');
    const { job } = await uploadClip(jobId, 'scene_02.mp4');

    assert.deepStrictEqual(
      job.uploadedClips.map((clip) => clip.sourceFilename),
      ['scene_01.mp4', 'scene_02.mp4', 'scene_03.mp4']
    );
    assert.strictEqual(job.clipsManuallyOrdered, false);
  });

  await test('POST /:id/upload-clip auto-sorts bare-numeric filenames uploaded in descending (wrong) order', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    await uploadClip(jobId, '20.mp4');
    await uploadClip(jobId, '19.mp4');
    await uploadClip(jobId, '18.mp4');
    const { job } = await uploadClip(jobId, '17.mp4');

    assert.deepStrictEqual(
      job.uploadedClips.map((clip) => clip.sourceFilename),
      ['17.mp4', '18.mp4', '19.mp4', '20.mp4']
    );
    assert.strictEqual(job.clipsManuallyOrdered, false);
  });

  await test('POST /:id/upload-clip leaves clips in upload order when filenames give no clear scene number', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    await uploadClip(jobId, 'beach-walk.mp4');
    const { job } = await uploadClip(jobId, 'sunset.mp4');

    assert.deepStrictEqual(job.uploadedClips.map((clip) => clip.sourceFilename), ['beach-walk.mp4', 'sunset.mp4']);
  });

  await test('POST /:id/upload-clip leaves clips in upload order when two filenames share the same scene number', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    await uploadClip(jobId, 'scene_01.mp4');
    const { job } = await uploadClip(jobId, 'scene_01.mp4');

    assert.deepStrictEqual(job.uploadedClips.map((clip) => clip.sourceFilename), ['scene_01.mp4', 'scene_01.mp4']);
  });

  await test('POST /:id/reorder-uploaded-clips rejects a set that does not exactly match the job\'s current clips', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;
    const { job } = await uploadClip(jobId, 'scene_01.mp4');
    await uploadClip(jobId, 'scene_02.mp4');

    const missingOne = await fetch(`${baseUrl}/api/jobs/${jobId}/reorder-uploaded-clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds: [job.uploadedClips[0].id] }),
    });
    assert.strictEqual(missingOne.status, 400);

    const unknownId = await fetch(`${baseUrl}/api/jobs/${jobId}/reorder-uploaded-clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds: ['not-a-real-id', 'also-not-real'] }),
    });
    assert.strictEqual(unknownId.status, 400);
  });

  await test('POST /:id/reorder-uploaded-clips applies the manual order and disables further auto-sorting', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const jobId = (await createRes.json()).job.id;

    // Ambiguous filenames, so these stay in upload order (A, B) until the
    // user manually reorders them.
    const uploadA = await uploadClip(jobId, 'intro.mp4');
    const uploadB = await uploadClip(jobId, 'outro.mp4');
    const clipAId = uploadA.clip.id;
    const clipBId = uploadB.clip.id;
    assert.deepStrictEqual(uploadB.job.uploadedClips.map((clip) => clip.id), [clipAId, clipBId]);

    const reorderRes = await fetch(`${baseUrl}/api/jobs/${jobId}/reorder-uploaded-clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds: [clipBId, clipAId] }),
    });
    assert.strictEqual(reorderRes.status, 200);
    const reorderedJob = (await reorderRes.json()).job;
    assert.deepStrictEqual(reorderedJob.uploadedClips.map((clip) => clip.id), [clipBId, clipAId]);
    assert.strictEqual(reorderedJob.clipsManuallyOrdered, true);

    // A new clip whose filename WOULD sort first (scene_01) must still only
    // be appended, not re-sorted in — the user's manual order is final.
    const uploadC = await uploadClip(jobId, 'scene_01.mp4');
    assert.deepStrictEqual(
      uploadC.job.uploadedClips.map((clip) => clip.id),
      [clipBId, clipAId, uploadC.clip.id]
    );
    assert.strictEqual(uploadC.job.clipsManuallyOrdered, true);
  });

  await test('POST /:id/select-clip-voiceovers rejects an unknown clip id', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/select-clip-voiceovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedClipIds: ['not-a-real-id'], voiceStyle: 'female-warm' }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /:id/select-clip-voiceovers rejects an invalid voiceStyle when clips are selected', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/select-clip-voiceovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedClipIds: [silentClipId], voiceStyle: 'not-a-real-voice' }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /:id/select-clip-voiceovers persists the selection and returns a cost estimate matching estimateClipVoiceoverCost', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/select-clip-voiceovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedClipIds: [silentClipId], voiceStyle: 'female-warm' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const expected = costEstimation.estimateClipVoiceoverCost(1);
    assert.strictEqual(body.costEstimate.totalUsd, expected.totalUsd);
    assert.deepStrictEqual(body.clipsWithExistingAudioSelected, []);
    assert.strictEqual(body.job.clipVoiceoverBatch.selectedClipIds.length, 1);
    assert.strictEqual(body.job.clipVoiceoverBatch.confirmed, false);

    const silent = body.job.uploadedClips.find((c) => c.id === silentClipId);
    const withAudio = body.job.uploadedClips.find((c) => c.id === audioClipId);
    assert.strictEqual(silent.voiceoverSelected, true);
    assert.strictEqual(withAudio.voiceoverSelected, false, 'the clip that already has audio must never be auto-selected');
  });

  await test('POST /:id/select-clip-voiceovers surfaces a warning when a clip that already has audio is explicitly selected', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/select-clip-voiceovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedClipIds: [silentClipId, audioClipId], voiceStyle: 'female-warm' }),
    });
    const body = await res.json();
    assert.deepStrictEqual(body.clipsWithExistingAudioSelected, [audioClipId]);
  });

  await test('POST /:id/generate-clip-voiceovers refuses when nothing has been selected yet', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const freshJobId = (await createRes.json()).job.id;
    const res = await fetch(`${baseUrl}/api/jobs/${freshJobId}/generate-clip-voiceovers`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
  });

  await test(
    'POST /:id/generate-clip-voiceovers generates a voice-over ONLY for the selected clip, leaving the unselected clip completely untouched',
    async () => {
      // Re-select just the silent clip (undoing the previous test's
      // both-selected state), matching the realistic "one confirm covers
      // exactly what was last reviewed" flow.
      await fetch(`${baseUrl}/api/jobs/${compileJobId}/select-clip-voiceovers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedClipIds: [silentClipId], voiceStyle: 'female-warm' }),
      });

      const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/generate-clip-voiceovers`, { method: 'POST' });
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      assert.strictEqual(body.job.clipVoiceoverBatch.status, 'completed');

      const generated = body.job.uploadedClips.find((c) => c.id === silentClipId);
      assert.strictEqual(generated.voiceoverStatus, 'completed', generated.voiceoverError || '');
      assert.ok(generated.processedUrl);
      assert.ok(generated.narrationText);

      const untouched = body.job.uploadedClips.find((c) => c.id === audioClipId);
      assert.strictEqual(untouched.voiceoverStatus, 'idle', "an unselected clip's voiceoverStatus must never change");
      assert.strictEqual(untouched.processedUrl, null);
      assert.strictEqual(untouched.voiceoverSelected, false, "an unselected clip's own audio must be left completely alone");
    }
  );

  // ---------------------------------------------------------------------
  // POST /:id/assemble-video — shared, generic final-assembly route, now
  // covering 'uploaded-clips' mode: stitches every uploaded clip (not just
  // the voice-over-selected ones) in upload order, skips a real reassembly
  // when nothing changed, and detects staleness when a new clip is added.
  // ---------------------------------------------------------------------

  let firstAssembleUrl;

  await test('POST /:id/assemble-video stitches every uploaded clip (voice-overed and untouched alike) into one final video', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/assemble-video`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');
    assert.ok(body.finalVideo.url);
    firstAssembleUrl = body.finalVideo.url;

    const localPath = firstAssembleUrl.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, firstAssembleUrl.slice('/generated/'.length))
      : firstAssembleUrl;
    const duration = await videoAssembly.getMediaDuration(localPath);
    // The voice-overed (originally silent) clip keeps its own ~3s video
    // length (narration padded with silence to fit, never trimming the
    // picture), plus the untouched clip's own ~3s — both clips present,
    // in order, regardless of which one got an AI voice-over.
    assert.ok(duration > 5.5 && duration < 6.5, `expected ~6s total, got ${duration}`);
  });

  await test('POST /:id/assemble-video is a free no-op when nothing has changed (same url, no reprocessing)', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.url, firstAssembleUrl, 'an unchanged job must reuse the existing assembled video, never reassemble it');
  });

  await test('POST /:id/assemble-video detects a real change (a newly uploaded clip) and reassembles', async () => {
    const uploadRes = await fetch(`${baseUrl}/api/jobs/${compileJobId}/upload-clip?filename=extra.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: audioClipBuffer,
    });
    assert.strictEqual(uploadRes.status, 200);

    const res = await fetch(`${baseUrl}/api/jobs/${compileJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');
    assert.notStrictEqual(body.finalVideo.url, firstAssembleUrl, 'a newly uploaded clip must force a real reassembly, not reuse the stale video');

    const localPath = body.finalVideo.url.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, body.finalVideo.url.slice('/generated/'.length))
      : body.finalVideo.url;
    const duration = await videoAssembly.getMediaDuration(localPath);
    assert.ok(duration > 8.5 && duration < 9.5, `expected ~9s total after the third clip, got ${duration}`);
  });

  await test('POST /:id/assemble-video refuses on a fresh uploaded-clips job with no clips at all', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const freshJobId = (await createRes.json()).job.id;
    const res = await fetch(`${baseUrl}/api/jobs/${freshJobId}/assemble-video`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
  });

  // ---------------------------------------------------------------------
  // POST /:id/assemble-video — automatic per-clip voice-over for any clip
  // the user never explicitly covered via select-clip-voiceovers/
  // generate-clip-voiceovers themselves (server.js's
  // autoGenerateMissingClipVoiceovers). The user should never have to
  // remember to add a voice-over to a silent clip — assembling now does it
  // for them, using the real (mocked) Claude vision + OpenAI TTS pipeline,
  // same as the manual flow.
  // ---------------------------------------------------------------------

  await test('POST /:id/assemble-video automatically generates a real voice-over for a silent clip the user never explicitly selected', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const autoJobId = (await createRes.json()).job.id;
    const uploadRes = await fetch(`${baseUrl}/api/jobs/${autoJobId}/upload-clip?filename=auto-silent.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });
    const uploadedClipId = (await uploadRes.json()).clip.id;

    const res = await fetch(`${baseUrl}/api/jobs/${autoJobId}/assemble-video`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');

    const clip = body.uploadedClips.find((c) => c.id === uploadedClipId);
    assert.strictEqual(clip.voiceoverStatus, 'completed', clip.voiceoverError || 'never ran at all');
    assert.ok(clip.processedUrl, 'a real processed (voiced) clip must have been produced');
    assert.ok(clip.narrationText, 'a real narration line must have been written');
    assert.strictEqual(
      body.clipVoiceoverVoice,
      'female-professional',
      'a job that never chose a voice must default to the same voice Story-to-Video itself defaults to'
    );
  });

  await test('POST /:id/assemble-video never generates a voice-over for a clip that already has its own real audio', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const autoJobId = (await createRes.json()).job.id;
    const uploadRes = await fetch(`${baseUrl}/api/jobs/${autoJobId}/upload-clip?filename=auto-audio.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: audioClipBuffer,
    });
    const uploadedClipId = (await uploadRes.json()).clip.id;

    const res = await fetch(`${baseUrl}/api/jobs/${autoJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');

    const clip = body.uploadedClips.find((c) => c.id === uploadedClipId);
    assert.strictEqual(clip.voiceoverStatus, 'idle', 'a clip with its own real audio must never be auto-voiced');
    assert.strictEqual(clip.processedUrl, null);
  });

  await test('POST /:id/assemble-video never re-generates a clip whose voice-over the user already completed manually', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const manualJobId = (await createRes.json()).job.id;
    const uploadRes = await fetch(`${baseUrl}/api/jobs/${manualJobId}/upload-clip?filename=manual-silent.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });
    const manualClipId = (await uploadRes.json()).clip.id;

    await fetch(`${baseUrl}/api/jobs/${manualJobId}/select-clip-voiceovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedClipIds: [manualClipId], voiceStyle: 'male-energetic' }),
    });
    const manualGenRes = await fetch(`${baseUrl}/api/jobs/${manualJobId}/generate-clip-voiceovers`, { method: 'POST' });
    const manualBody = await manualGenRes.json();
    const manuallyVoicedClip = manualBody.job.uploadedClips.find((c) => c.id === manualClipId);
    assert.strictEqual(manuallyVoicedClip.voiceoverStatus, 'completed', manuallyVoicedClip.voiceoverError || '');
    const originalProcessedUrl = manuallyVoicedClip.processedUrl;
    const originalNarrationText = manuallyVoicedClip.narrationText;

    const res = await fetch(`${baseUrl}/api/jobs/${manualJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');

    const clipAfterAssembly = body.uploadedClips.find((c) => c.id === manualClipId);
    assert.strictEqual(
      clipAfterAssembly.processedUrl,
      originalProcessedUrl,
      'a clip already voiced through the manual flow must never be silently regenerated by the automatic one'
    );
    assert.strictEqual(clipAfterAssembly.narrationText, originalNarrationText);
    // The user's own manually-chosen voice must stick, never silently
    // overridden by the automatic default.
    assert.strictEqual(body.clipVoiceoverVoice, 'male-energetic');
  });

  await test('POST /:id/assemble-video refuses clearly (never silently assembles a still-silent video) when a key needed for automatic voice-over is missing', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const noKeyJobId = (await createRes.json()).job.id;
    await fetch(`${baseUrl}/api/jobs/${noKeyJobId}/upload-clip?filename=no-key.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: silentClipBuffer,
    });

    const realKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let res;
    try {
      res = await fetch(`${baseUrl}/api/jobs/${noKeyJobId}/assemble-video`, { method: 'POST' });
    } finally {
      process.env.OPENAI_API_KEY = realKey;
    }
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.ok(/OPENAI_API_KEY/.test(body.error));

    const persisted = await jobStore.getJob(noKeyJobId);
    assert.notStrictEqual(
      persisted.finalVideo.status,
      'completed',
      'must never produce a final video that silently skipped the automatic voice-over it promised'
    );
  });

  await test('POST /:id/assemble-video mixes in uploaded background music for an uploaded-clips job', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const musicJobId = (await createRes.json()).job.id;
    await fetch(`${baseUrl}/api/jobs/${musicJobId}/upload-clip?filename=clip.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: audioClipBuffer,
    });

    const musicBuffer = fs.readFileSync(musicTrackPath);
    const musicUploadRes = await fetch(`${baseUrl}/api/jobs/${musicJobId}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: musicBuffer,
    });
    assert.strictEqual(musicUploadRes.status, 200);

    const res = await fetch(`${baseUrl}/api/jobs/${musicJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');
    assert.deepStrictEqual(body.finalVideo.musicUsed, { enabled: true, track: null, customUrl: body.musicCustomUrl });
  });

  // End-to-end reproduction of a real production report: clips named
  // plainly "1.mp4"/"2.mp4", uploaded in REVERSE order through the real
  // HTTP routes (exactly what a browser's own file-picker order did in
  // production) — confirms not just that job.uploadedClips LISTS the
  // correct order (already covered above), but that the REAL assembled
  // output file actually plays back in that same order, end to end
  // through POST /:id/assemble-video.
  await test('POST /:id/assemble-video produces output in the correct order for bare-numeric filenames uploaded in reverse', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const orderJobId = (await createRes.json()).job.id;

    // "2.mp4" (the 900Hz clip) uploaded FIRST, "1.mp4" (the 300Hz clip)
    // uploaded SECOND — reverse of the intended scene order, same as the
    // real report.
    await fetch(`${baseUrl}/api/jobs/${orderJobId}/upload-clip?filename=2.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: fs.readFileSync(highToneClipPath),
    });
    const uploadRes = await fetch(`${baseUrl}/api/jobs/${orderJobId}/upload-clip?filename=1.mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: fs.readFileSync(toneClipPath),
    });
    const uploadedJob = (await uploadRes.json()).job;
    assert.deepStrictEqual(
      uploadedJob.uploadedClips.map((clip) => clip.sourceFilename),
      ['1.mp4', '2.mp4'],
      'the uploaded-clips list must already show the corrected ascending order'
    );

    const res = await fetch(`${baseUrl}/api/jobs/${orderJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');

    const localPath = body.finalVideo.url.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, body.finalVideo.url.slice('/generated/'.length))
      : body.finalVideo.url;

    const vol300AtStart = await measureBandVolume(localPath, { freq: 300, start: 0.2, duration: 1.4 });
    const vol900AtStart = await measureBandVolume(localPath, { freq: 900, start: 0.2, duration: 1.4 });
    assert.ok(
      vol300AtStart > vol900AtStart + 10,
      `expected clip "1.mp4"'s 300Hz tone first, but got 300Hz=${vol300AtStart}dB vs 900Hz=${vol900AtStart}dB — the real output file is in the wrong order`
    );

    const vol900AtEnd = await measureBandVolume(localPath, { freq: 900, start: 2.2, duration: 1.4 });
    const vol300AtEnd = await measureBandVolume(localPath, { freq: 300, start: 2.2, duration: 1.4 });
    assert.ok(
      vol900AtEnd > vol300AtEnd + 10,
      `expected clip "2.mp4"'s 900Hz tone second, but got 900Hz=${vol900AtEnd}dB vs 300Hz=${vol300AtEnd}dB — the real output file is in the wrong order`
    );
  });

  // End-to-end reproduction of the SECOND real production report: the same
  // "list looks right, but try it and the video is still wrong" complaint
  // persisted because the real clips were named "1_20261004173834.mp4",
  // "2_20261004173834.mp4", ... (a scene number, then "_", then a
  // generation timestamp) — a shape the first fix (bare-numeric-only
  // filenames) didn't cover, so these fell back to ambiguous upload order
  // yet again. Scrambles all 5 of this job's distinctly-toned clips (not
  // just 2) across their real filename shape, uploaded via the real HTTP
  // route, then verifies the real assembled output's actual audio — not
  // just the uploaded-clips list — plays back in the corrected 1..5 order.
  await test('POST /:id/assemble-video produces output in the correct order for "N_<timestamp>.mp4" filenames uploaded out of order', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/upload-compile`, { method: 'POST' });
    const timestampJobId = (await createRes.json()).job.id;

    const clipsInUploadOrder = [
      { filename: '3_20261004173829.mp4', path: silentMiddleClipPath }, // scene 3: silence
      { filename: '1_20261004173834.mp4', path: toneClipPath }, // scene 1: 300Hz
      { filename: '5_20261004173832.mp4', path: highestToneClipPath }, // scene 5: 1200Hz
      { filename: '2_20261004173834.mp4', path: midToneClipPath }, // scene 2: 500Hz
      { filename: '4_20261004173835.mp4', path: highToneClipPath }, // scene 4: 900Hz
    ];

    let lastUploadedJob;
    for (const { filename, path: clipPath } of clipsInUploadOrder) {
      const res = await fetch(`${baseUrl}/api/jobs/${timestampJobId}/upload-clip?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: fs.readFileSync(clipPath),
      });
      lastUploadedJob = (await res.json()).job;
    }

    assert.deepStrictEqual(
      lastUploadedJob.uploadedClips.map((clip) => clip.sourceFilename),
      [
        '1_20261004173834.mp4',
        '2_20261004173834.mp4',
        '3_20261004173829.mp4',
        '4_20261004173835.mp4',
        '5_20261004173832.mp4',
      ],
      'the uploaded-clips list must show the corrected ascending order'
    );

    const res = await fetch(`${baseUrl}/api/jobs/${timestampJobId}/assemble-video`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(body.finalVideo.status, 'completed', body.finalVideo.error || '');

    const localPath = body.finalVideo.url.startsWith('/generated/')
      ? path.join(require('./video-storage').GENERATED_DIR, body.finalVideo.url.slice('/generated/'.length))
      : body.finalVideo.url;

    const windows = [
      { label: 'scene 1 (300Hz)', start: 0.2, expectFreq: 300, otherFreq: 1200 },
      { label: 'scene 2 (500Hz)', start: 2.2, expectFreq: 500, otherFreq: 1200 },
      { label: 'scene 4 (900Hz)', start: 6.2, expectFreq: 900, otherFreq: 300 },
      { label: 'scene 5 (1200Hz)', start: 8.2, expectFreq: 1200, otherFreq: 300 },
    ];
    for (const { label, start, expectFreq, otherFreq } of windows) {
      const expectVol = await measureBandVolume(localPath, { freq: expectFreq, start, duration: 1.4 });
      const otherVol = await measureBandVolume(localPath, { freq: otherFreq, start, duration: 1.4 });
      assert.ok(
        expectVol > otherVol + 10,
        `the real output's segment for ${label} at ${start}s must carry its own real tone — got ${expectFreq}Hz=${expectVol}dB vs ${otherFreq}Hz=${otherVol}dB`
      );
    }
  });

  httpServer.close();
  mockAnthropicServer.close();
  mockOpenAiServer.close();
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
    console.log('\nAll Upload & Compile tests passed.');
  }
}

main();
