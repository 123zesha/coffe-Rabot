// Tests for backend/video-assembly.js — the real ffmpeg-based final video
// assembly module. Every clip/voice-over "input" here is a real, tiny local
// media file this test generates itself with the same ffmpeg binary the
// module uses (via ffmpeg-static) — no Runway, OpenAI, Anthropic, or any
// other paid API is ever called. This proves the module can produce a real,
// playable MP4 from local/mock media alone.
//
// assembleFinalVideo returns the assembled video's raw bytes (a Buffer),
// never a url — see backend/video-storage.js (and
// test-video-storage.js/test-assemble-final-video.js) for the separate
// storage step that turns that buffer into job.finalVideo.url.
//
// Run with:
//   node test-video-assembly.js
// or:
//   npm run test:video-assembly

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const { assembleFinalVideo, getMediaDuration, ffmpegPath } = require('./video-assembly');

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

const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-assembly-fixtures-'));

function makeClip(name, color, durationSeconds = 1) {
  const outPath = path.join(fixturesDir, name);
  execFileSync(
    ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=${durationSeconds}`, '-r', '30', '-pix_fmt', 'yuv420p', outPath],
    { stdio: 'ignore' }
  );
  return outPath;
}

function makeAudio(name, durationSeconds = 1) {
  const outPath = path.join(fixturesDir, name);
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`, outPath], {
    stdio: 'ignore',
  });
  return outPath;
}

// Decodes the given file with ffmpeg (output discarded) purely to prove the
// bytes are a real, playable media file, and returns ffmpeg's own stderr log
// (which lists every stream it found, e.g. "Video: h264" / "Audio: aac") so
// tests can assert on what streams the assembled output actually contains.
// Uses spawnSync (not execFileSync) because ffmpeg writes this log to
// stderr on a SUCCESSFUL decode too, and execFileSync only captures stderr
// when the command actually fails.
function probe(filePath) {
  const result = spawnSync(ffmpegPath, ['-y', '-i', filePath, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `ffmpeg could not decode ${filePath}:\n${result.stderr}`);
  return result.stderr || '';
}

async function main() {
  const redClipPath = makeClip('red.mp4', 'red');
  const blueClipPath = makeClip('blue.mp4', 'blue');
  const audioPath = makeAudio('voice.mp3');

  await test('assembleFinalVideo concatenates two completed local-file clips into one real, playable MP4 buffer', async () => {
    const result = await assembleFinalVideo({
      clips: [
        { status: 'completed', url: redClipPath },
        { status: 'completed', url: blueClipPath },
      ],
      voiceover: null,
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0, 'must return a real, non-empty Buffer');
    // Every valid MP4 has an 'ftyp' box near the start of the file — this is
    // a real, structural proof the bytes are an actual MP4, not arbitrary
    // data.
    assert.ok(result.buffer.slice(4, 12).toString('ascii').includes('ftyp'), 'output must be a real MP4 file');

    const tmpOut = path.join(fixturesDir, 'check-concat.mp4');
    fs.writeFileSync(tmpOut, result.buffer);
    const log = probe(tmpOut);
    assert.ok(log.includes('Video:'), 'ffmpeg must be able to decode a real video stream from the output');
  });

  await test('assembleFinalVideo fetches clips served over real http(s) URLs, not just local paths', async () => {
    const server = http.createServer((req, res) => {
      const filePath = req.url === '/red.mp4' ? redClipPath : blueClipPath;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      fs.createReadStream(filePath).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const result = await assembleFinalVideo({
        clips: [
          { status: 'completed', url: `http://localhost:${port}/red.mp4` },
          { status: 'completed', url: `http://localhost:${port}/blue.mp4` },
        ],
        voiceover: null,
      });

      assert.strictEqual(result.status, 'completed');
      assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0);
    } finally {
      server.close();
    }
  });

  await test('assembleFinalVideo decodes a data: URI clip url (the same shape voiceover.url already uses)', async () => {
    const dataUri = `data:video/mp4;base64,${fs.readFileSync(redClipPath).toString('base64')}`;

    const result = await assembleFinalVideo({
      clips: [{ status: 'completed', url: dataUri }],
      voiceover: null,
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0);
  });

  await test('assembleFinalVideo resolves a /generated/ clip url from disk (video-storage.js\'s local-dev reference), not as an HTTP fetch or a literal path', async () => {
    const { GENERATED_DIR } = require('./video-storage');
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const storedFilename = `test-generated-clip-${Date.now()}.mp4`;
    fs.copyFileSync(redClipPath, path.join(GENERATED_DIR, storedFilename));

    try {
      const result = await assembleFinalVideo({
        clips: [{ status: 'completed', url: `/generated/${storedFilename}` }],
        voiceover: null,
      });

      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0);
    } finally {
      fs.rmSync(path.join(GENERATED_DIR, storedFilename), { force: true });
    }
  });

  await test('assembleFinalVideo mixes in the existing voice-over audio track when one is completed', async () => {
    const voiceoverDataUri = `data:audio/mpeg;base64,${fs.readFileSync(audioPath).toString('base64')}`;

    const result = await assembleFinalVideo({
      clips: [
        { status: 'completed', url: redClipPath },
        { status: 'completed', url: blueClipPath },
      ],
      voiceover: { status: 'completed', url: voiceoverDataUri },
    });

    assert.strictEqual(result.status, 'completed');

    const tmpOut = path.join(fixturesDir, 'check-with-audio.mp4');
    fs.writeFileSync(tmpOut, result.buffer);
    const log = probe(tmpOut);
    assert.ok(log.includes('Video:'), 'output must still have a video stream');
    assert.ok(log.includes('Audio:'), 'output must have the voice-over mixed in as a real audio stream');
  });

  await test("assembleFinalVideo stretches the final video to the voice-over's full real duration when narration outlasts the clips (no more silent truncation)", async () => {
    // Two 1-second clips (2s of video) against a 6-second voice-over — the
    // old '-shortest'-only behavior would have cut the output (and 4 of
    // the 6 seconds of narration) down to just 2 seconds.
    const longVoiceoverPath = makeAudio('long-voice.mp3', 6);
    const voiceoverDataUri = `data:audio/mpeg;base64,${fs.readFileSync(longVoiceoverPath).toString('base64')}`;

    const result = await assembleFinalVideo({
      clips: [
        { status: 'completed', url: redClipPath },
        { status: 'completed', url: blueClipPath },
      ],
      voiceover: { status: 'completed', url: voiceoverDataUri },
    });

    assert.strictEqual(result.status, 'completed');

    const tmpOut = path.join(fixturesDir, 'check-sync-long-audio.mp4');
    fs.writeFileSync(tmpOut, result.buffer);
    const outputDuration = await getMediaDuration(tmpOut);

    assert.ok(
      Math.abs(outputDuration - 6) < 0.5,
      `expected the final video to run the full ~6s of narration, got ${outputDuration}s`
    );
  });

  await test('assembleFinalVideo trims the final video down to the voice-over\'s real duration when narration is shorter than the clips', async () => {
    // Two 3-second clips (6s of video) against a 2-second voice-over.
    const shortClipA = makeClip('sync-short-a.mp4', 'green', 3);
    const shortClipB = makeClip('sync-short-b.mp4', 'yellow', 3);
    const shortVoiceoverPath = makeAudio('short-voice.mp3', 2);
    const voiceoverDataUri = `data:audio/mpeg;base64,${fs.readFileSync(shortVoiceoverPath).toString('base64')}`;

    const result = await assembleFinalVideo({
      clips: [
        { status: 'completed', url: shortClipA },
        { status: 'completed', url: shortClipB },
      ],
      voiceover: { status: 'completed', url: voiceoverDataUri },
    });

    assert.strictEqual(result.status, 'completed');

    const tmpOut = path.join(fixturesDir, 'check-sync-short-audio.mp4');
    fs.writeFileSync(tmpOut, result.buffer);
    const outputDuration = await getMediaDuration(tmpOut);

    assert.ok(
      Math.abs(outputDuration - 2) < 0.5,
      `expected the final video trimmed to the ~2s voice-over, got ${outputDuration}s`
    );
  });

  await test("assembleFinalVideo gives every scene an equal share of the voice-over regardless of the clips' own original lengths", async () => {
    // A 1s clip and a 3s clip against a 4s voice-over — each scene should
    // be retimed to 2s (4s / 2 scenes) so they line up with the narration,
    // not left at its own unrelated original length.
    const shortClip = makeClip('sync-equal-short.mp4', 'purple', 1);
    const longClip = makeClip('sync-equal-long.mp4', 'orange', 3);
    const voiceoverPath = makeAudio('equal-voice.mp3', 4);
    const voiceoverDataUri = `data:audio/mpeg;base64,${fs.readFileSync(voiceoverPath).toString('base64')}`;

    const result = await assembleFinalVideo({
      clips: [
        { status: 'completed', url: shortClip },
        { status: 'completed', url: longClip },
      ],
      voiceover: { status: 'completed', url: voiceoverDataUri },
    });

    assert.strictEqual(result.status, 'completed');

    const tmpOut = path.join(fixturesDir, 'check-sync-equal-share.mp4');
    fs.writeFileSync(tmpOut, result.buffer);
    const outputDuration = await getMediaDuration(tmpOut);

    assert.ok(
      Math.abs(outputDuration - 4) < 0.5,
      `expected the combined output to run the full ~4s (2 scenes x 2s each), got ${outputDuration}s`
    );
  });

  await test('assembleFinalVideo produces a real, playable video-only file when there is no voice-over yet', async () => {
    for (const voiceover of [null, undefined, { status: 'pending', url: null }, { status: 'failed', url: null, error: 'x' }]) {
      const result = await assembleFinalVideo({
        clips: [{ status: 'completed', url: redClipPath }],
        voiceover,
      });

      assert.strictEqual(result.status, 'completed', `expected success with voiceover=${JSON.stringify(voiceover)}`);

      const tmpOut = path.join(fixturesDir, 'check-video-only.mp4');
      fs.writeFileSync(tmpOut, result.buffer);
      const log = probe(tmpOut);
      assert.ok(log.includes('Video:'));
      assert.ok(!log.includes('Audio:'), 'a missing/incomplete voice-over must never produce a fabricated audio track');
    }
  });

  await test('assembleFinalVideo returns a real failure, never a fabricated buffer, when a clip cannot be fetched', async () => {
    const result = await assembleFinalVideo({
      clips: [{ status: 'completed', url: 'http://localhost:1/does-not-exist.mp4' }],
      voiceover: null,
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.buffer, null);
    assert.ok(result.error && result.error.length > 0);
  });

  await test('assembleFinalVideo returns a clear failure for an empty clips array instead of crashing', async () => {
    const result = await assembleFinalVideo({ clips: [], voiceover: null });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.buffer, null);
    assert.ok(result.error.toLowerCase().includes('clip'));
  });

  fs.rmSync(fixturesDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll video-assembly tests passed.');
  }
}

main();
