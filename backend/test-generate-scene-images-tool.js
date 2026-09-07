// Tests for the new generateSceneImages Agent tool (backend/server.js),
// which lets the conversational Agent trigger the existing, real
// image-generation backend (backend/image-generation.js — the same module
// and logic already used by POST /api/jobs/:id/generate-images) instead of
// telling the user image generation must happen outside the conversation.
//
// Uses a local mock OpenAI images server (no real OpenAI API calls, no
// cost) and the local data/jobs.json fallback (no Redis needed). Calls
// server.js's executeTool directly — exported for exactly this purpose —
// rather than driving the whole /api/agent + Anthropic tool-use loop, since
// the tool's own logic (not Claude's tool-choice behavior) is what needs
// covering here. Run with:
//   node test-generate-scene-images-tool.js
// or:
//   npm run test:generate-scene-images-tool

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;
fs.writeFileSync(JOBS_FILE, '[]\n');

// server.js constructs an Anthropic client at module load time, which
// requires an API key to be present even though this test never calls
// Claude — a harmless placeholder is enough.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const app = require('./server');
const jobStore = require('./job-store');

let failures = 0;
let mockOpenAiServer;
let mockOpenAiRequestCount = 0;

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

// A minimal stand-in for the real OpenAI Images API: regardless of which
// endpoint the SDK hits (generations vs. edits) or the request body, it
// drains the request and returns one valid base64 image, counting calls so
// tests can assert exactly how many real generation calls were made.
function startMockOpenAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      mockOpenAiRequestCount++;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZWltYWdlZGF0YQ==' }] }));
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  mockOpenAiServer = await startMockOpenAi();
  const openAiPort = mockOpenAiServer.address().port;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openAiPort}/v1`;

  await test('generateSceneImages generates real images for all imagePrompts when none exist yet', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene A: a lighthouse at dusk', 'Scene B: a boat at sea'],
      videoPrompts: ['Slow pan across the lighthouse', 'Camera follows the boat'],
      characters: ['Mira'],
    });

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 2, 'expected one real generation call per new prompt');
    assert.strictEqual(result.images.length, 2);
    assert.ok(result.images.every((image) => image.status === 'completed'));

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.images.length, 2);
    assert.ok(persisted.images.every((image) => image.url && image.url.startsWith('data:image/')));
  });

  await test('generateSceneImages skips a scene whose image is already completed, never re-charging it', async () => {
    const job = await jobStore.createJob();
    const alreadyDoneUrl = 'data:image/png;base64,alreadydonepreviously';
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene A: already generated', 'Scene B: not generated yet'],
      videoPrompts: ['Pan across scene A', 'Pan across scene B'],
      characters: ['Mira'],
      images: [{ prompt: 'Scene A: already generated', url: alreadyDoneUrl, status: 'completed' }],
    });

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 1, 'only the missing scene should trigger a real generation call');
    assert.strictEqual(result.images.length, 2);
    assert.ok(result.images.every((image) => image.status === 'completed'));

    // The agent-facing result deliberately strips raw image URLs (same
    // payload-size protection already applied to images/voiceover
    // elsewhere) — check the real persisted job for the actual URLs.
    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.images[0].url, alreadyDoneUrl, 'the already-completed image must be reused untouched');
    assert.strictEqual(persisted.images[1].status, 'completed');
    assert.notStrictEqual(persisted.images[1].url, alreadyDoneUrl);
  });

  await test('generateSceneImages returns a clear error and makes no call when there are no imagePrompts yet', async () => {
    const job = await jobStore.createJob();

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 0);
    assert.ok(result.error.toLowerCase().includes('imageprompts'));
  });

  // Regression test for the real production failure: a job reached ASSET
  // GENERATION with imagePrompts set (and, live, a real scene image already
  // generated) but videoPrompts left empty. Scene video generation later
  // failed with "job has no videoPrompts to generate video from" — safe
  // (zero Runway calls) but discovered only after the image had already
  // been generated and paid for. The root-cause fix checks this pairing
  // BEFORE the image call too, so the very first paid step refuses until
  // both are prepared, and tells the Agent exactly how to fix it itself.
  await test('generateSceneImages refuses — before any OpenAI call — when imagePrompts is set but videoPrompts is empty', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { imagePrompts: ['Scene 1: a lighthouse at dusk'] });

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 0, 'no OpenAI call may happen while videoPrompts is missing');
    assert.ok(result.error.toLowerCase().includes('videoprompts'));
    assert.ok(result.error.toLowerCase().includes('updatevideojob'), 'the error must tell the Agent how to fix it itself');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.images.length, 0, 'no image may be generated or persisted');
  });

  await test('generateSceneImages refuses — before any OpenAI call — when imagePrompts and videoPrompts have different lengths', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: ['Scene 1', 'Scene 2'],
      videoPrompts: ['Pan across Scene 1'],
    });

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 0, 'a scene-count mismatch must never reach OpenAI');
    assert.ok(result.error.includes('2') && result.error.includes('1'), 'the error should state both counts');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.images.length, 0);
  });

  // Regression test for the real production failure: a real, paid Runway
  // request failed with "promptText: Invalid input: expected string,
  // received object" because a videoPrompts entry was an object, not a
  // string — the updateVideoJob schema now requires string items, but this
  // proves the tool also refuses on the job's actual current data.
  await test('generateSceneImages refuses — before any OpenAI call — when an imagePrompts entry is not a string', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      imagePrompts: [{ description: 'Scene 1 as an object, not a string' }],
      videoPrompts: ['Pan across Scene 1'],
    });

    mockOpenAiRequestCount = 0;
    const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));

    assert.strictEqual(mockOpenAiRequestCount, 0, 'a non-string imagePrompts entry must never reach OpenAI');
    assert.ok(result.error.includes('imagePrompts[0]'));
    assert.ok(result.error.toLowerCase().includes('updatevideojob'));
  });

  await test('generateSceneImages returns a clear error and makes no call when OPENAI_API_KEY is missing', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { imagePrompts: ['Scene A'], videoPrompts: ['Pan across Scene A'] });

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    mockOpenAiRequestCount = 0;

    try {
      const result = JSON.parse(await app.executeTool('generateSceneImages', job.id, {}));
      assert.strictEqual(mockOpenAiRequestCount, 0);
      assert.ok(result.error.toLowerCase().includes('not configured') || result.error.toLowerCase().includes('unavailable'));
    } finally {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  await test('generateSceneImages reports job not found for an unknown job id', async () => {
    const result = JSON.parse(await app.executeTool('generateSceneImages', 'does-not-exist', {}));
    assert.strictEqual(result.error, 'job not found');
  });

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
    console.log('\nAll generateSceneImages tool tests passed.');
  }
}

main();
