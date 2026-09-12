// Tests for the new generateYoutubePackage Agent tool (backend/server.js)
// and its REST route (POST /api/jobs/:id/generate-youtube-package) — the
// optional "YouTube Publishing Package" feature. backend/youtube-package.js's
// own text-generation logic (JSON parsing/sanitization) is already covered
// directly by test-youtube-package.js; this is the tool/route integration
// layer, mirroring test-generate-voiceover-tool.js and
// test-analyze-reference-video-tool.js's patterns.
//
// Uses local mock HTTP servers for Anthropic's /v1/messages and OpenAI's
// image endpoints — no real network call to Anthropic or OpenAI is ever
// made, no cost. Run with:
//   node test-generate-youtube-package-tool.js
// or:
//   npm run test:generate-youtube-package-tool

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

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

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

// A real script long enough to pass jobStore.MIN_SCRIPT_LENGTH (200 chars).
const REAL_SCRIPT =
  'Welcome to this video about the quiet lighthouse at the edge of town. ' +
  'For a hundred years it has guided ships safely home through fog and storm. ' +
  'Tonight, we look at the people who kept its light burning, generation after generation.';

const OTHER_REAL_SCRIPT =
  'This video tells the story of a small bakery that opened its doors during a snowstorm. ' +
  'Despite the odds, the owner welcomed in every stranded traveler with warm bread and coffee. ' +
  'Years later, that single night became the town\'s most cherished tradition.';

const VALID_PACKAGE_JSON = JSON.stringify({
  titles: ['The Lighthouse That Never Sleeps', 'A Century of Light', 'Guardians of the Shore'],
  description: 'A short documentary about the lighthouse keepers who kept the light burning for a century.',
  tags: ['lighthouse', 'documentary', 'history'],
  thumbnailConcept: 'A glowing lighthouse at dusk against a stormy sky.',
  thumbnailText: 'A CENTURY OF LIGHT',
});

let anthropicRequestCount = 0;
let lastAnthropicPrompt = null;
let anthropicResponder = (body, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text: VALID_PACKAGE_JSON }] }));
};

let openAiRequestCount = 0;
let openAiShouldFail = false;

async function main() {
  const anthropicServer = await startMockServer((req, res) => {
    anthropicRequestCount++;
    if (req.url !== '/v1/messages') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        body = null;
      }
      lastAnthropicPrompt = body && Array.isArray(body.messages) ? body.messages[0].content : null;
      anthropicResponder(body, res);
    });
  });
  const anthropicPort = anthropicServer.address().port;

  const openAiServer = await startMockServer((req, res) => {
    openAiRequestCount++;
    req.on('data', () => {});
    req.on('end', () => {
      if (openAiShouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'simulated OpenAI image outage' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZXRodW1ibmFpbA==' }] }));
    });
  });
  const openAiPort = openAiServer.address().port;

  // Must be set BEFORE requiring server.js — server.js constructs its own
  // Anthropic client at module load time, which requires a key to be
  // present even though most tests here go through youtube-package.js's
  // own independent client instead.
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicPort}`;

  const app = require('./server');
  const jobStore = require('./job-store');

  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openAiPort}/v1`;

  await test('generateYoutubePackage refuses — before any call — when the job has no script yet', async () => {
    const job = await jobStore.createJob();

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 0);
    assert.strictEqual(openAiRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('script'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'pending');
  });

  await test('generateYoutubePackage refuses — before any call — when the script is too short', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: 'Too short.' });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 0);
    assert.strictEqual(openAiRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('short'));
  });

  await test('generateYoutubePackage generates a real text package plus a real thumbnail image, and persists both', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { topic: 'The old lighthouse', script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 1, 'expected exactly one real Claude call');
    assert.strictEqual(openAiRequestCount, 1, 'expected exactly one real OpenAI image call');
    assert.strictEqual(result.youtubePackage.status, 'completed', JSON.stringify(result));
    assert.strictEqual(result.youtubePackage.titles.length, 3);
    assert.ok(result.youtubePackage.description.includes('lighthouse keepers'));
    assert.strictEqual(result.youtubePackage.hasThumbnailImage, true);
    // The agent-facing summary must never carry the raw base64 thumbnail.
    assert.strictEqual(result.youtubePackage.thumbnailUrl, undefined);
    assert.ok(lastAnthropicPrompt.includes(REAL_SCRIPT), 'the real final script must reach the analysis prompt');
    assert.ok(lastAnthropicPrompt.includes('The old lighthouse'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'completed');
    assert.ok(persisted.youtubePackage.thumbnailUrl && persisted.youtubePackage.thumbnailUrl.startsWith('data:image/'));
    assert.strictEqual(persisted.youtubePackage.generatedFromScript, REAL_SCRIPT);
  });

  await test('generateYoutubePackage is a free no-op on a second call with an unchanged script — never re-spends a real call', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const first = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
    assert.strictEqual(first.youtubePackage.status, 'completed');
    assert.strictEqual(anthropicRequestCount, 1);
    assert.strictEqual(openAiRequestCount, 1);

    const second = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
    assert.strictEqual(anthropicRequestCount, 1, 'a second call with an unchanged script must not make another real Claude call');
    assert.strictEqual(openAiRequestCount, 1, 'a second call with an unchanged script must not make another real OpenAI call');
    assert.deepStrictEqual(second.youtubePackage.titles, first.youtubePackage.titles, 'must return the existing package unchanged');
  });

  await test('generateYoutubePackage re-generates for real when the script changes', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    await app.executeTool('generateYoutubePackage', job.id, {});
    assert.strictEqual(anthropicRequestCount, 1);

    await jobStore.updateJob(job.id, { script: OTHER_REAL_SCRIPT });
    const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 2, 'a changed script must trigger a fresh real Claude call');
    assert.strictEqual(openAiRequestCount, 2);
    assert.strictEqual(result.youtubePackage.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.generatedFromScript, OTHER_REAL_SCRIPT);
  });

  await test('generateYoutubePackage forceRegenerate: true re-generates for real even with an unchanged script', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    await app.executeTool('generateYoutubePackage', job.id, {});
    assert.strictEqual(anthropicRequestCount, 1);

    await app.executeTool('generateYoutubePackage', job.id, { forceRegenerate: true });
    assert.strictEqual(anthropicRequestCount, 2, 'forceRegenerate must bypass the skip-if-unchanged guard');
    assert.strictEqual(openAiRequestCount, 2);
  });

  await test('generateYoutubePackage does NOT cache a failed text generation — it always retries on unchanged input', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    const originalResponder = anthropicResponder;
    anthropicResponder = (body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'not valid json at all' }] }));
    };

    try {
      anthropicRequestCount = 0;
      openAiRequestCount = 0;
      const first = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
      assert.strictEqual(first.youtubePackage.status, 'failed');
      assert.strictEqual(anthropicRequestCount, 1);
      assert.strictEqual(openAiRequestCount, 0, 'no thumbnail image call must happen when the text package failed');

      const second = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
      assert.strictEqual(second.youtubePackage.status, 'failed');
      assert.strictEqual(anthropicRequestCount, 2, 'a failed generation must never be treated as cached');
    } finally {
      anthropicResponder = originalResponder;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'failed');
  });

  await test('generateYoutubePackage still completes the text package when only the thumbnail image call fails', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    openAiShouldFail = true;
    try {
      anthropicRequestCount = 0;
      openAiRequestCount = 0;
      const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

      assert.strictEqual(anthropicRequestCount, 1);
      // The OpenAI SDK retries a 500 response by default, so this may be
      // more than one real HTTP attempt — the point of this test is that
      // the failure doesn't crash or fabricate a result, not the exact
      // retry count.
      assert.ok(openAiRequestCount >= 1);
      assert.strictEqual(result.youtubePackage.status, 'completed', 'titles/description/tags must still be reported as completed');
      assert.strictEqual(result.youtubePackage.hasThumbnailImage, false);
      assert.ok(result.youtubePackage.error, 'a thumbnail-specific error must be reported');
    } finally {
      openAiShouldFail = false;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.thumbnailUrl, null);
  });

  await test('generateYoutubePackage still completes the text package when OPENAI_API_KEY is missing (no thumbnail image)', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      anthropicRequestCount = 0;
      openAiRequestCount = 0;
      const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));

      assert.strictEqual(anthropicRequestCount, 1);
      assert.strictEqual(openAiRequestCount, 0, 'no OpenAI call may happen when OPENAI_API_KEY is missing');
      assert.strictEqual(result.youtubePackage.status, 'completed');
      assert.strictEqual(result.youtubePackage.hasThumbnailImage, false);
      assert.ok(result.youtubePackage.error.toLowerCase().includes('not configured'));
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  await test('generateYoutubePackage returns a clear error and makes no call when ANTHROPIC_API_KEY is missing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    anthropicRequestCount = 0;
    openAiRequestCount = 0;

    try {
      const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
      assert.strictEqual(anthropicRequestCount, 0);
      assert.strictEqual(openAiRequestCount, 0);
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'pending', 'must not fabricate a result when unconfigured');
  });

  await test('generateYoutubePackage reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('generateYoutubePackage', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
  });

  await test('updateVideoJob can turn generateYoutubePackage on and off, default is off on a new job', async () => {
    const job = await jobStore.createJob();
    assert.strictEqual(job.generateYoutubePackage, false);

    const result = JSON.parse(await app.executeTool('updateVideoJob', job.id, { generateYoutubePackage: true }));
    assert.strictEqual(result.generateYoutubePackage, true);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.generateYoutubePackage, true);
  });

  await test('updateVideoJob ignores a direct attempt to set youtubePackage — it is backend-populated only', async () => {
    const job = await jobStore.createJob();

    await app.executeTool('updateVideoJob', job.id, {
      youtubePackage: { status: 'completed', titles: ['fabricated'], description: 'fabricated', tags: [] },
    });

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'pending', 'youtubePackage must not be settable via updateVideoJob');
    assert.deepStrictEqual(persisted.youtubePackage.titles, []);
  });

  await test('summarizeJobForAgent never leaks the internal generatedFromScript bookkeeping field', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    const result = JSON.parse(await app.executeTool('generateYoutubePackage', job.id, {}));
    assert.strictEqual(result.youtubePackage.generatedFromScript, undefined);
  });

  await test('the YouTube package is never generated automatically — only an explicit tool call ever populates it', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      topic: 'A story about a fox',
      script: REAL_SCRIPT,
      generateYoutubePackage: true,
    });

    // Turning the setting on by itself (via updateVideoJob, exactly like
    // every other preference) must never itself trigger generation or any
    // real API call — only calling generateYoutubePackage does.
    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.youtubePackage.status, 'pending');
    assert.strictEqual(anthropicRequestCount, 0);
    assert.strictEqual(openAiRequestCount, 0);
  });

  // --- POST /api/jobs/:id/generate-youtube-package (Final Review button) ---
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('POST /generate-youtube-package generates a real package via the REST route', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-youtube-package`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(anthropicRequestCount, 1);
    assert.strictEqual(openAiRequestCount, 1);
    assert.strictEqual(body.youtubePackage.status, 'completed');
    // The REST route returns the RAW job (like GET /api/jobs/:id) — the
    // real thumbnail data URI must be present here, unlike the agent's
    // stripped-down summary.
    assert.ok(body.youtubePackage.thumbnailUrl && body.youtubePackage.thumbnailUrl.startsWith('data:image/'));
  });

  await test('POST /generate-youtube-package refuses with the same reason as the tool (no script)', async () => {
    const job = await jobStore.createJob();

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-youtube-package`, { method: 'POST' });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(anthropicRequestCount, 0);
    assert.strictEqual(openAiRequestCount, 0);
    assert.ok(body.error.toLowerCase().includes('script'));
  });

  await test('POST /generate-youtube-package is a free no-op on an unchanged script, and forceRegenerate bypasses it', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: REAL_SCRIPT });

    anthropicRequestCount = 0;
    openAiRequestCount = 0;
    await fetch(`${baseUrl}/api/jobs/${job.id}/generate-youtube-package`, { method: 'POST' });
    assert.strictEqual(anthropicRequestCount, 1);

    await fetch(`${baseUrl}/api/jobs/${job.id}/generate-youtube-package`, { method: 'POST' });
    assert.strictEqual(anthropicRequestCount, 1, 'an unchanged script must not re-spend a real call via the REST route either');

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/generate-youtube-package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceRegenerate: true }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(anthropicRequestCount, 2, 'forceRegenerate must bypass the skip-if-unchanged guard via the REST route too');
  });

  server.close();
  anthropicServer.close();
  openAiServer.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_BASE_URL;

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll generateYoutubePackage tool/route tests passed.');
  }
}

main();
