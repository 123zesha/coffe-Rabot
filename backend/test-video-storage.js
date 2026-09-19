// Tests for backend/video-storage.js — the module that stores an assembled
// final video's, a scene clip's, or a generated voice-over's real bytes
// OUTSIDE the job record (Vercel Blob in production, a local file in dev),
// returning only a lightweight reference URL for job.finalVideo.url /
// job.videoGeneration.clips[i].url / job.voiceover.url. See that module's
// own comment for why: a multi-scene final video or a real 15-20 minute
// voice-over track is far larger than the base64 images still embedded
// directly in a job record, and risks the same Redis/Upstash payload-size
// failure PR #25 fixed for job-store.js (and that a real voice-over
// generation actually hit in production before storeAudioFile existed).
//
// The Vercel Blob upload path is exercised with a fake injected `putBlob`
// (no real network call to Vercel Blob — this app's zero-real-external-call
// testing discipline applies here too, not just to Runway/OpenAI/
// Anthropic). The local-file fallback path uses the real filesystem, since
// that IS the real production behavior for an environment with no
// BLOB_READ_WRITE_TOKEN configured.
//
// Run with:
//   node test-video-storage.js
// or:
//   npm run test:video-storage

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { storeFinalVideo, storeAudioFile, hasBlobToken, GENERATED_DIR } = require('./video-storage');

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

async function main() {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  await test('hasBlobToken is false when BLOB_READ_WRITE_TOKEN is not set', () => {
    assert.strictEqual(hasBlobToken(), false);
  });

  await test('storeFinalVideo writes a real local file and returns a /generated/ reference when no Blob token is set', async () => {
    const buffer = Buffer.from('fake mp4 bytes for the local-fallback path');

    const url = await storeFinalVideo(buffer, 'job-123');

    assert.ok(url.startsWith('/generated/final-video-job-123-'), `unexpected url: ${url}`);
    assert.ok(url.endsWith('.mp4'));

    const filename = url.replace('/generated/', '');
    const onDisk = fs.readFileSync(path.join(GENERATED_DIR, filename));
    assert.ok(onDisk.equals(buffer), 'the exact bytes passed in must be the exact bytes written to disk');
  });

  await test('storeFinalVideo never embeds the video bytes in its returned reference (stays small regardless of video size)', async () => {
    // Simulates a "large" multi-scene final video — real generated videos
    // will be real MP4 bytes, but size is what this test cares about, not
    // content: even at several MB, the reference this function returns must
    // stay a short string, never the encoded video itself.
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024, 1);

    const url = await storeFinalVideo(bigBuffer, 'job-big');

    assert.ok(url.length < 200, `expected a short reference, got ${url.length} characters`);
    assert.ok(!url.startsWith('data:'), 'must never fall back to embedding the video as a data: URI');
  });

  await test('storeFinalVideo gives two assemblies of the same job different filenames (no collision on retry)', async () => {
    const buffer = Buffer.from('same job, two different assemblies');

    const urlA = await storeFinalVideo(buffer, 'job-retry');
    const urlB = await storeFinalVideo(buffer, 'job-retry');

    assert.notStrictEqual(urlA, urlB);
  });

  await test('storeFinalVideo rejects an empty buffer instead of writing/uploading nothing silently', async () => {
    await assert.rejects(() => storeFinalVideo(Buffer.alloc(0), 'job-empty'));
  });

  await test('storeFinalVideo uploads to Vercel Blob (via the injected put) when BLOB_READ_WRITE_TOKEN is set', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-token-for-this-test';
    try {
      assert.strictEqual(hasBlobToken(), true);

      const buffer = Buffer.from('fake mp4 bytes for the blob path');
      const calls = [];
      const fakePutBlob = async (filename, body, options) => {
        calls.push({ filename, body, options });
        return { url: `https://fake-store.public.blob.vercel-storage.com/${filename}` };
      };

      const url = await storeFinalVideo(buffer, 'job-456', { putBlob: fakePutBlob });

      assert.strictEqual(calls.length, 1, 'must call the Blob put exactly once, never fall back to a local file');
      assert.strictEqual(calls[0].body, buffer);
      assert.strictEqual(calls[0].options.access, 'public');
      assert.strictEqual(calls[0].options.contentType, 'video/mp4');
      assert.strictEqual(url, `https://fake-store.public.blob.vercel-storage.com/${calls[0].filename}`);
      assert.ok(url.startsWith('https://'));
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  await test('storeFinalVideo surfaces a real Blob upload failure instead of silently falling back to local storage', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-token-for-this-test';
    try {
      const fakePutBlob = async () => {
        throw new Error('simulated Vercel Blob outage');
      };

      await assert.rejects(
        () => storeFinalVideo(Buffer.from('x'), 'job-789', { putBlob: fakePutBlob }),
        /simulated Vercel Blob outage/
      );
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  await test('storeAudioFile writes a real local .mp3 file and returns a /generated/ reference when no Blob token is set', async () => {
    const buffer = Buffer.from('fake mp3 bytes for the local-fallback path');

    const url = await storeAudioFile(buffer, 'job-audio-123');

    assert.ok(url.startsWith('/generated/voiceover-job-audio-123-'), `unexpected url: ${url}`);
    assert.ok(url.endsWith('.mp3'));

    const filename = url.replace('/generated/', '');
    const onDisk = fs.readFileSync(path.join(GENERATED_DIR, filename));
    assert.ok(onDisk.equals(buffer), 'the exact bytes passed in must be the exact bytes written to disk');
  });

  await test('storeAudioFile never embeds the audio bytes in its returned reference (stays small regardless of audio size)', async () => {
    // Simulates a real 15-20 minute voice-over track — real audio will be
    // real MP3 bytes, but size is what this test cares about: even at
    // several MB (large enough that its base64 encoding alone would exceed
    // Upstash's 10 MB request limit), the reference this function returns
    // must stay a short string, never the encoded audio itself.
    const bigBuffer = Buffer.alloc(8 * 1024 * 1024, 1);

    const url = await storeAudioFile(bigBuffer, 'job-big-audio');

    assert.ok(url.length < 200, `expected a short reference, got ${url.length} characters`);
    assert.ok(!url.startsWith('data:'), 'must never fall back to embedding the audio as a data: URI');
  });

  await test('storeAudioFile gives two voice-overs of the same job different filenames (no collision on retry)', async () => {
    const buffer = Buffer.from('same job, two different voice-overs');

    const urlA = await storeAudioFile(buffer, 'job-audio-retry');
    const urlB = await storeAudioFile(buffer, 'job-audio-retry');

    assert.notStrictEqual(urlA, urlB);
  });

  await test('storeAudioFile rejects an empty buffer instead of writing/uploading nothing silently', async () => {
    await assert.rejects(() => storeAudioFile(Buffer.alloc(0), 'job-audio-empty'));
  });

  await test('storeAudioFile uploads to Vercel Blob as audio/mpeg (via the injected put) when BLOB_READ_WRITE_TOKEN is set', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-token-for-this-test';
    try {
      const buffer = Buffer.from('fake mp3 bytes for the blob path');
      const calls = [];
      const fakePutBlob = async (filename, body, options) => {
        calls.push({ filename, body, options });
        return { url: `https://fake-store.public.blob.vercel-storage.com/${filename}` };
      };

      const url = await storeAudioFile(buffer, 'job-audio-456', { putBlob: fakePutBlob });

      assert.strictEqual(calls.length, 1, 'must call the Blob put exactly once, never fall back to a local file');
      assert.strictEqual(calls[0].body, buffer);
      assert.strictEqual(calls[0].options.access, 'public');
      assert.strictEqual(calls[0].options.contentType, 'audio/mpeg');
      assert.ok(calls[0].filename.endsWith('.mp3'));
      assert.strictEqual(url, `https://fake-store.public.blob.vercel-storage.com/${calls[0].filename}`);
      assert.ok(url.startsWith('https://'));
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  await test('storeFinalVideo is unaffected by storeAudioFile — still uploads as video/mp4 with a .mp4 filename', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-token-for-this-test';
    try {
      const calls = [];
      const fakePutBlob = async (filename, body, options) => {
        calls.push({ filename, options });
        return { url: `https://fake-store.public.blob.vercel-storage.com/${filename}` };
      };

      await storeFinalVideo(Buffer.from('fake mp4 bytes'), 'job-video-still-mp4', { putBlob: fakePutBlob });

      assert.strictEqual(calls[0].options.contentType, 'video/mp4');
      assert.ok(calls[0].filename.endsWith('.mp4'));
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });

  if (originalToken !== undefined) {
    process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll video-storage tests passed.');
  }
}

main();
