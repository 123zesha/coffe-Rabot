// Tests for the new analyzeReferenceVideo Agent tool (backend/server.js) and
// the updateVideoJob schema additions (referenceVideoUrl/referenceVideoNotes)
// that support it — "Reference Video / Inspiration Mode". This is the
// tool/executeTool integration layer; backend/reference-video.js's own logic
// (URL parsing, oEmbed, caption scraping, the analysis prompt) is already
// covered directly by test-reference-video.js.
//
// Uses local mock HTTP servers for the YouTube oEmbed/watch-page endpoints
// and for Anthropic's /v1/messages — no real network call to YouTube or
// Anthropic is ever made, no cost. Calls server.js's executeTool directly,
// exactly like test-generate-voiceover-tool.js does for generateVoiceover.
//
// YOUTUBE_OEMBED_BASE_URL/YOUTUBE_WATCH_BASE_URL are read once by
// reference-video.js at require time, so the mock YouTube server (and the
// env vars pointing at it) must exist BEFORE server.js is first required
// (server.js requires reference-video.js itself). ANTHROPIC_BASE_URL is read
// lazily (only when reference-video.js's own Anthropic client is first
// constructed), so it's safe to set any time before the first real call.
//
// Run with:
//   node test-analyze-reference-video-tool.js
// or:
//   npm run test:analyze-reference-video-tool

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

const REFERENCE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Mutable state the mock YouTube server reads on every request, so each test
// can steer oEmbed/caption behavior without restarting the (long-lived)
// server or busting reference-video.js's require cache.
let oembedResponse = { status: 200, body: { title: 'Some Real Title', author_name: 'Some Channel' } };
let watchHtml = '<html><body>no captions here</body></html>';

let anthropicRequestCount = 0;
let lastAnthropicPrompt = null;
let anthropicResponder = (body, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Pacing: brisk. Tone: hopeful. Structure: setup, escalation, resolution.' }],
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
    })
  );
};

async function main() {
  const youtubeServer = await startMockServer((req, res) => {
    if (req.url.startsWith('/oembed')) {
      res.writeHead(oembedResponse.status, { 'Content-Type': 'application/json' });
      res.end(oembedResponse.status === 200 ? JSON.stringify(oembedResponse.body) : '');
      return;
    }
    if (req.url.startsWith('/watch')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(watchHtml);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const youtubePort = youtubeServer.address().port;

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

  // Must be set BEFORE requiring server.js — reference-video.js reads
  // YOUTUBE_OEMBED_BASE_URL/YOUTUBE_WATCH_BASE_URL as module-level consts at
  // require time.
  process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${youtubePort}/oembed`;
  process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${youtubePort}/watch`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicPort}`;

  const app = require('./server');
  const jobStore = require('./job-store');

  await test('analyzeReferenceVideo performs a real end-to-end analysis and persists it on the job', async () => {
    const job = await jobStore.createJob();

    const updateResult = JSON.parse(
      await app.executeTool('updateVideoJob', job.id, {
        referenceVideoUrl: REFERENCE_URL,
        referenceVideoNotes: 'A short film about a fox who learns patience while waiting out a storm.',
      })
    );
    assert.strictEqual(updateResult.referenceVideoUrl, REFERENCE_URL);
    assert.strictEqual(updateResult.referenceVideoNotes, 'A short film about a fox who learns patience while waiting out a storm.');

    anthropicRequestCount = 0;
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 1, 'expected exactly one real Claude call');
    assert.strictEqual(result.referenceVideoAnalysis.status, 'completed', JSON.stringify(result));
    assert.ok(result.referenceVideoAnalysis.summary.includes('Pacing'));
    assert.ok(lastAnthropicPrompt.includes('Some Real Title'), 'real oEmbed metadata must reach the analysis prompt');

    // summarizeJobForAgent must NOT strip this field — unlike heavy/binary
    // media fields (images[].url, voiceover, finalVideo) it's lightweight
    // text the Agent needs to actually read.
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.status, 'completed');
    assert.strictEqual(persisted.referenceVideoAnalysis.summary, result.referenceVideoAnalysis.summary);
  });

  await test('summarizeJobForAgent strips the internal analyzedUrl/analyzedNotes bookkeeping fields', async () => {
    const job = await jobStore.createJob();
    await app.executeTool('updateVideoJob', job.id, { referenceVideoUrl: REFERENCE_URL });

    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
    assert.strictEqual(result.referenceVideoAnalysis.analyzedUrl, undefined);
    assert.strictEqual(result.referenceVideoAnalysis.analyzedNotes, undefined);

    // The raw job record still keeps them — that's what the skip-guard reads.
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.analyzedUrl, REFERENCE_URL);
  });

  await test('analyzeReferenceVideo is a free no-op on a second call with the exact same URL/notes — never re-spends a Claude call', async () => {
    const job = await jobStore.createJob();
    await app.executeTool('updateVideoJob', job.id, {
      referenceVideoUrl: REFERENCE_URL,
      referenceVideoNotes: 'A story about a lighthouse keeper.',
    });

    anthropicRequestCount = 0;
    const first = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
    assert.strictEqual(first.referenceVideoAnalysis.status, 'completed');
    assert.strictEqual(anthropicRequestCount, 1);

    const second = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
    assert.strictEqual(anthropicRequestCount, 1, 'a second call with unchanged URL/notes must not make another real Claude call');
    assert.strictEqual(second.referenceVideoAnalysis.status, 'completed');
    assert.strictEqual(second.referenceVideoAnalysis.summary, first.referenceVideoAnalysis.summary, 'must return the existing analysis unchanged');

    // A third, fourth, ... call keeps being free too — this isn't a
    // one-shot allowance.
    await app.executeTool('analyzeReferenceVideo', job.id, {});
    await app.executeTool('analyzeReferenceVideo', job.id, {});
    assert.strictEqual(anthropicRequestCount, 1);
  });

  await test('analyzeReferenceVideo re-analyzes for real when referenceVideoUrl changes after a completed analysis', async () => {
    const job = await jobStore.createJob();
    await app.executeTool('updateVideoJob', job.id, { referenceVideoUrl: REFERENCE_URL });

    anthropicRequestCount = 0;
    await app.executeTool('analyzeReferenceVideo', job.id, {});
    assert.strictEqual(anthropicRequestCount, 1);

    const otherUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
    await app.executeTool('updateVideoJob', job.id, { referenceVideoUrl: otherUrl });
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 2, 'a changed referenceVideoUrl must trigger a fresh real Claude call');
    assert.strictEqual(result.referenceVideoAnalysis.status, 'completed');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.analyzedUrl, otherUrl);
  });

  await test('analyzeReferenceVideo re-analyzes for real when only referenceVideoNotes changes after a completed analysis', async () => {
    const job = await jobStore.createJob();
    await app.executeTool('updateVideoJob', job.id, { referenceVideoUrl: REFERENCE_URL, referenceVideoNotes: 'first notes' });

    anthropicRequestCount = 0;
    await app.executeTool('analyzeReferenceVideo', job.id, {});
    assert.strictEqual(anthropicRequestCount, 1);

    await app.executeTool('updateVideoJob', job.id, { referenceVideoNotes: 'completely different notes now' });
    await app.executeTool('analyzeReferenceVideo', job.id, {});

    assert.strictEqual(anthropicRequestCount, 2, 'changed referenceVideoNotes alone must also trigger a fresh real Claude call');
  });

  await test('analyzeReferenceVideo does NOT cache a failed analysis — it always retries on the same unchanged input', async () => {
    const job = await jobStore.createJob();
    await app.executeTool('updateVideoJob', job.id, { referenceVideoUrl: 'https://vimeo.com/12345678' });

    anthropicRequestCount = 0;
    const first = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
    assert.strictEqual(first.referenceVideoAnalysis.status, 'failed');
    assert.strictEqual(anthropicRequestCount, 0, 'a non-YouTube URL fails before any Claude call, first time');

    const second = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
    assert.strictEqual(second.referenceVideoAnalysis.status, 'failed');
    assert.strictEqual(anthropicRequestCount, 0, 'a failed analysis is never treated as cached — it keeps trying, not silently skipping');
  });

  await test('analyzeReferenceVideo reports job not found for an unknown job id', async () => {
    anthropicRequestCount = 0;
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
    assert.strictEqual(anthropicRequestCount, 0);
  });

  await test('analyzeReferenceVideo refuses — before any Claude call — when referenceVideoUrl was never set', async () => {
    const job = await jobStore.createJob();

    anthropicRequestCount = 0;
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('referencevideourl'));
  });

  await test('analyzeReferenceVideo refuses — before any Claude call — when referenceVideoUrl is only whitespace', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { referenceVideoUrl: '   ' });

    anthropicRequestCount = 0;
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('referencevideourl'));
  });

  await test('analyzeReferenceVideo returns a clear error and makes no Claude call when ANTHROPIC_API_KEY is missing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { referenceVideoUrl: REFERENCE_URL });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    anthropicRequestCount = 0;

    try {
      const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
      assert.strictEqual(anthropicRequestCount, 0);
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.status, 'pending', 'must not fabricate a result when unconfigured');
  });

  await test('analyzeReferenceVideo persists a real failure, never a fabricated success, for a non-YouTube URL', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { referenceVideoUrl: 'https://vimeo.com/12345678' });

    anthropicRequestCount = 0;
    const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));

    assert.strictEqual(anthropicRequestCount, 0, 'an unrecognizable URL must be rejected before any Claude call');
    assert.strictEqual(result.referenceVideoAnalysis.status, 'failed');
    assert.ok(result.referenceVideoAnalysis.error.toLowerCase().includes('youtube'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.status, 'failed');
  });

  await test('updateVideoJob accepts referenceVideoNotes on its own, without requiring referenceVideoUrl', async () => {
    const job = await jobStore.createJob();

    const result = JSON.parse(
      await app.executeTool('updateVideoJob', job.id, { referenceVideoNotes: 'Just some notes, no URL yet.' })
    );
    assert.strictEqual(result.referenceVideoNotes, 'Just some notes, no URL yet.');
    assert.strictEqual(result.referenceVideoUrl, '', 'referenceVideoUrl must stay at its untouched default');
  });

  await test('updateVideoJob ignores a direct attempt to set referenceVideoAnalysis — it is backend-populated only', async () => {
    const job = await jobStore.createJob();

    await app.executeTool('updateVideoJob', job.id, {
      referenceVideoAnalysis: { status: 'completed', summary: 'fabricated by a client', error: null },
    });

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.status, 'pending', 'referenceVideoAnalysis must not be settable via updateVideoJob');
    assert.strictEqual(persisted.referenceVideoAnalysis.summary, null);
  });

  await test('analyzeReferenceVideo returns a real failure (not fabricated) when the Claude call itself fails', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { referenceVideoUrl: REFERENCE_URL });

    const originalResponder = anthropicResponder;
    anthropicResponder = (body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated Anthropic outage' } }));
    };

    try {
      const result = JSON.parse(await app.executeTool('analyzeReferenceVideo', job.id, {}));
      assert.strictEqual(result.referenceVideoAnalysis.status, 'failed');
      assert.ok(result.referenceVideoAnalysis.summary === null || result.referenceVideoAnalysis.summary === undefined);
    } finally {
      anthropicResponder = originalResponder;
    }

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.referenceVideoAnalysis.status, 'failed');
  });

  youtubeServer.close();
  anthropicServer.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  delete process.env.YOUTUBE_OEMBED_BASE_URL;
  delete process.env.YOUTUBE_WATCH_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll analyzeReferenceVideo tool tests passed.');
  }
}

main();
