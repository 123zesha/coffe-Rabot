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
const http = require('http');
const assert = require('assert');

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
        res.end(Buffer.from('fake mp3 audio bytes'));
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
    assert.ok(persisted.voiceover.url && persisted.voiceover.url.startsWith('data:audio/'));
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
