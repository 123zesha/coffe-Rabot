// Tests for the new generateVoiceover Agent tool (backend/server.js), which
// lets the conversational Agent trigger the existing, real voice-over
// backend (backend/voiceover-generation.js — the same module and logic
// already used by POST /api/jobs/:id/generate-voiceover, the Final Review
// "Generate Voice-over" button) instead of having no voice-over capability
// in chat at all. Also covers that REST route directly, since both now
// share findVoiceoverBlocker and the finalVideo-reset behavior.
//
// Uses a local mock OpenAI TTS server (no real OpenAI API calls, no cost)
// and the local data/jobs.json fallback (no Redis needed). Calls
// server.js's executeTool directly for the tool, and real HTTP requests for
// the REST route. Run with:
//   node test-generate-voiceover-tool.js
// or:
//   npm run test:generate-voiceover-tool

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// A real, validly-encoded MP3 buffer (~3 MB, several times larger than
// OpenAI's real gpt-4o-mini-tts output for a ~4000-character chunk) used by
// the large-audio stress test below in place of arbitrary non-audio bytes —
// voiceover-generation.js's chunk-joining logic now actually decodes each
// chunk (see its concatenateAudioChunks), so the mocked "TTS response" must
// be real, decodable audio, not filler bytes. Generated once via ffmpeg's
// own lavfi silent source (ffmpeg-static, already a project dependency) —
// no network, no paid API, and independent of any locally-installed tool.
const LARGE_MOCK_AUDIO_BUFFER = (() => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mock-tts-audio-')), 'silence.mp3');
  execFileSync(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '75',
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    outPath,
  ]);
  return fs.readFileSync(outPath);
})();

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const app = require('./server');
const jobStore = require('./job-store');

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

// A real script long enough to pass jobStore.MIN_SCRIPT_LENGTH (200 chars).
const REAL_SCRIPT =
  'Welcome to this video about the quiet lighthouse at the edge of town. ' +
  'For a hundred years it has guided ships safely home through fog and storm. ' +
  'Tonight, we look at the people who kept its light burning, generation after generation.';

let mockRequestCount = 0;
let mockShouldFail = false;
let lastRequestBody = null;
let useLargeMockAudio = false;

function startMockOpenAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      mockRequestCount++;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          lastRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          lastRequestBody = null;
        }

        if (mockShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'simulated OpenAI TTS outage' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(useLargeMockAudio ? LARGE_MOCK_AUDIO_BUFFER : Buffer.from('fake mp3 audio bytes'));
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  const mockOpenAiServer = await startMockOpenAi();
  const openAiPort = mockOpenAiServer.address().port;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openAiPort}/v1`;

  await test('generateVoiceover generates a real voice-over from the job script', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));

    assert.strictEqual(mockRequestCount, 1, 'expected exactly one real TTS call for a short script');
    assert.strictEqual(result.voiceover.status, 'completed');
    // summarizeJobForAgent must strip the audio URL from the conversation,
    // same as every other generated-media field.
    assert.strictEqual(result.voiceover.url, undefined);

    const persisted = await jobStore.getJob(job.id);
    // The audio is stored OUTSIDE the job record (video-storage.js) — see
    // the "stays safely under the Redis/Upstash payload limit" test below
    // for why. No BLOB_READ_WRITE_TOKEN is set in this test process, so
    // this exercises the local-file fallback.
    assert.ok(persisted.voiceover.url && persisted.voiceover.url.startsWith('/generated/voiceover-'));
    assert.ok(persisted.voiceover.url.endsWith('.mp3'));
  });

  await test('a real-length voice-over keeps the persisted job record safely under the Upstash 10 MB request limit', async () => {
    // Reproduces the exact real production failure this fix addresses: a
    // ~12,800-character script (this app's own real 15-20 minute target
    // length) split into several TTS chunks (MAX_TTS_INPUT_LENGTH = 4096),
    // each chunk here a real ~2.9 MB MP3 (LARGE_MOCK_AUDIO_BUFFER) — several
    // times larger than OpenAI's real gpt-4o-mini-tts output for a
    // ~4000-character chunk, chosen deliberately so the combined audio (well
    // over 10 MB) WOULD have blown the Upstash "ERR max request size
    // exceeded (10485760 bytes)" limit had it still been embedded as a
    // base64 data: URI in the job record — the real error seen in
    // production logs. Must be REAL, decodable audio (not arbitrary bytes):
    // voiceover-generation.js's concatenateAudioChunks now actually decodes
    // every chunk to join them at the sample level (see its own comment).
    const LONG_SCRIPT = Array(55).fill(REAL_SCRIPT).join(' '); // ~12,800 characters
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: LONG_SCRIPT });

    mockRequestCount = 0;
    useLargeMockAudio = true;
    const bytesPerChunkUsed = LARGE_MOCK_AUDIO_BUFFER.length;
    let result;
    try {
      result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    } finally {
      useLargeMockAudio = false;
    }

    assert.ok(mockRequestCount >= 3, `expected multiple TTS chunks for a ~12,700 character script, got ${mockRequestCount}`);
    assert.strictEqual(result.voiceover.status, 'completed', JSON.stringify(result));

    const totalSynthesizedAudioBytes = mockRequestCount * bytesPerChunkUsed;
    // Sanity-check the scenario itself is a real stress test, not a trivial one.
    assert.ok(
      totalSynthesizedAudioBytes > 10 * 1024 * 1024,
      'test setup: the simulated audio must itself exceed the 10 MB Upstash limit for this to be a meaningful regression test'
    );

    const persisted = await jobStore.getJob(job.id);
    assert.ok(persisted.voiceover.url.startsWith('/generated/voiceover-'), 'must reference stored audio, never embed it');

    const persistedJobBytes = Buffer.byteLength(JSON.stringify(persisted), 'utf8');
    const UPSTASH_MAX_REQUEST_SIZE_BYTES = 10 * 1024 * 1024;
    assert.ok(
      persistedJobBytes < UPSTASH_MAX_REQUEST_SIZE_BYTES,
      `persisted job record is ${persistedJobBytes} bytes — must stay safely under Upstash's ${UPSTASH_MAX_REQUEST_SIZE_BYTES}-byte request limit`
    );
    // Not just "under the limit" — actually small, proving the audio really
    // was stored outside the record rather than merely fitting by luck.
    assert.ok(persistedJobBytes < 50 * 1024, `expected a small job record (only a reference URL), got ${persistedJobBytes} bytes`);
  });

  await test('generateVoiceover sets voiceStyle and uses the matching OpenAI voice in the same call', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, { voiceStyle: 'female-warm' }));

    assert.strictEqual(mockRequestCount, 1);
    assert.strictEqual(result.voiceover.status, 'completed');
    assert.strictEqual(result.voiceover.voiceStyle, 'female-warm');
    // voiceover-generation.js's VOICE_MAP: 'female-warm' -> 'shimmer'.
    assert.strictEqual(lastRequestBody.voice, 'shimmer', 'expected the mapped OpenAI voice for female-warm');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceStyle, 'female-warm', 'voiceStyle must be persisted on the job, not just used transiently');
  });

  await test('generateVoiceover re-generates from scratch every call — no "already done" skip like images/video', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT, voiceStyle: 'male-energetic' });

    mockRequestCount = 0;
    const first = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    assert.strictEqual(first.voiceover.status, 'completed');

    const second = JSON.parse(await app.executeTool('generateVoiceover', job.id, { voiceStyle: 'neutral-narrator' }));
    assert.strictEqual(second.voiceover.status, 'completed');

    assert.strictEqual(mockRequestCount, 2, '"regenerate with a different voice" must always make a fresh real call');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceStyle, 'neutral-narrator');
  });

  await test('generateVoiceover refuses — before any OpenAI call — when the job has no script yet', async () => {
    const job = await jobStore.createJob();

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));

    assert.strictEqual(mockRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('script'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceover.status, 'pending');
  });

  await test('generateVoiceover refuses — before any OpenAI call — when the script is too short', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: 'Too short.' });

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));

    assert.strictEqual(mockRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('short'));
  });

  await test('generateVoiceover refuses — before any OpenAI call — when voiceStyle is already "none"', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT, voiceStyle: 'none' });

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));

    assert.strictEqual(mockRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('no voice-over'));
  });

  await test('generateVoiceover refuses — before any OpenAI call — if voiceStyle is explicitly set to "none" in the same call', async () => {
    // Defense in depth: the tool's own input_schema enum already excludes
    // 'none' when called through the real Anthropic tool-use loop, but this
    // proves the runtime check (findVoiceoverBlocker, re-evaluated AFTER
    // the voiceStyle update) still catches it if ever bypassed.
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT, voiceStyle: 'male-warm' });

    mockRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, { voiceStyle: 'none' }));

    assert.strictEqual(mockRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('no voice-over'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceStyle, 'none', 'the voiceStyle update itself is harmless and still applies');
  });

  await test('generateVoiceover returns a clear error and makes no call when OPENAI_API_KEY is missing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    mockRequestCount = 0;

    try {
      const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
      assert.strictEqual(mockRequestCount, 0);
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  await test('generateVoiceover reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('generateVoiceover', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
  });

  await test('a successful generateVoiceover resets an already-assembled final video (it is now stale)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      finalVideo: { url: '/generated/final-video-old.mp4', status: 'completed' },
    });

    mockShouldFail = false;
    const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
    assert.strictEqual(result.voiceover.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'a stale final video must not still read as completed');
    assert.strictEqual(persisted.finalVideo.url, null);
  });

  await test('a FAILED generateVoiceover does not disturb an existing, still-valid final video', async () => {
    const job = await jobStore.createJob();
    const existingFinalVideoUrl = '/generated/final-video-still-good.mp4';
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      finalVideo: { url: existingFinalVideoUrl, status: 'completed' },
    });

    mockShouldFail = true;
    try {
      const result = JSON.parse(await app.executeTool('generateVoiceover', job.id, {}));
      assert.strictEqual(result.voiceover.status, 'failed');
    } finally {
      mockShouldFail = false;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'completed', 'a failed voice-over attempt must not invalidate the still-accurate existing final video');
    assert.strictEqual(persisted.finalVideo.url, existingFinalVideoUrl);
  });

  // --- POST /api/jobs/:id/generate-voiceover (the existing Final Review
  // button's route) — proves the findVoiceoverBlocker refactor kept it
  // working identically, and that it gets the same finalVideo-reset fix.
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('POST /generate-voiceover still works exactly as before (Final Review button)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    mockRequestCount = 0;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-voiceover`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(mockRequestCount, 1);
    assert.strictEqual(body.voiceover.status, 'completed');
  });

  await test('POST /generate-voiceover refuses with the same reasons as before (no script)', async () => {
    const job = await jobStore.createJob();

    mockRequestCount = 0;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-voiceover`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(mockRequestCount, 0);
    assert.ok(body.error.toLowerCase().includes('script'));
  });

  await test('POST /generate-voiceover also resets an already-assembled final video on success', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: REAL_SCRIPT,
      finalVideo: { url: '/generated/final-video-old-2.mp4', status: 'completed' },
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-voiceover`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.finalVideo.status, 'pending');
  });

  server.close();
  mockOpenAiServer.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll generateVoiceover tool/route tests passed.');
  }
}

main();
