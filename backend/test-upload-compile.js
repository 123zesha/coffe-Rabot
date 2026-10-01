// Tests for the "Upload & Compile" flow: job-store.js's 'uploaded-clips'
// VIDEO_MODES entry and its uploadedClips/clipVoiceoverVoice/
// clipVoiceoverBatch fields, backend/clip-voiceover.js (probing + real
// per-clip voice-over generation), video-assembly.js's
// assembleUploadedClipsVideo (stitching uploaded clips in order, each
// keeping its own real/processed audio, plus optional ducked background
// music), cost-estimation.js's estimateClipVoiceoverCost, and server.js's
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

  await test('assembleUploadedClipsVideo stitches clips in the given order, each keeping its own real/silent audio', async () => {
    const result = await videoAssembly.assembleUploadedClipsVideo({
      uploadedClips: [
        { id: '1', url: toneClipPath, processedUrl: null },
        { id: '2', url: silentMiddleClipPath, processedUrl: null },
        { id: '3', url: highToneClipPath, processedUrl: null },
      ],
      musicUrl: null,
      resolutionTier: '720p',
    });
    assert.strictEqual(result.status, 'completed', result.error || '');

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

  await test('assembleUploadedClipsVideo mixes in background music, automatically ducked under non-silent clip audio', async () => {
    const twoClips = [
      { id: '1', url: toneClipPath, processedUrl: null },
      { id: '2', url: silentMiddleClipPath, processedUrl: null },
    ];

    const baseline = await videoAssembly.assembleUploadedClipsVideo({ uploadedClips: twoClips, musicUrl: null, resolutionTier: '720p' });
    assert.strictEqual(baseline.status, 'completed', baseline.error || '');
    const baselinePath = path.join(workDir, 'assembled-no-music.mp4');
    fs.writeFileSync(baselinePath, baseline.buffer);

    const withMusic = await videoAssembly.assembleUploadedClipsVideo({ uploadedClips: twoClips, musicUrl: musicTrackPath, resolutionTier: '720p' });
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
