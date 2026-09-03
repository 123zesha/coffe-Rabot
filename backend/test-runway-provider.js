// Tests for backend/video-providers/runway.js — the real Runway Gen-4
// Turbo HTTP integration. Every test injects a fake fetch implementation
// (matching the fetch(url, options) => Response-like contract), so this
// suite makes zero real network calls and spends zero real Runway credits.
// Run with:
//   node test-runway-provider.js
// or:
//   npm run test:runway-provider

const assert = require('assert');

// Keep this a fixed, harmless value for the whole run — never a real
// secret, and never read from the real environment.
process.env.RUNWAYML_API_SECRET = 'test-secret';

const runway = require('./video-providers/runway');

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

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function fakeFetch(handler) {
  return async (url, options) => handler(url, options);
}

async function main() {
  await test('submitVideoGeneration returns processing on a successful submit', async () => {
    const fetchImpl = fakeFetch(async (url, options) => {
      assert.ok(url.endsWith('/image_to_video'));
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers.Authorization, 'Bearer test-secret');
      assert.strictEqual(options.headers['X-Runway-Version'], '2024-11-06');
      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, 'gen4_turbo');
      assert.strictEqual(body.promptImage, 'data:image/png;base64,abc');
      assert.strictEqual(body.promptText, 'slow pan across the coastline');
      assert.strictEqual(body.duration, 5);
      assert.strictEqual(body.ratio, '16:9');
      return jsonResponse(200, { id: 'task_123' });
    });

    const result = await runway.submitVideoGeneration(
      { imageDataUri: 'data:image/png;base64,abc', prompt: 'slow pan across the coastline', durationSeconds: 5, ratio: '16:9' },
      fetchImpl
    );

    assert.deepStrictEqual(result, { status: 'processing', externalJobId: 'task_123', clips: [], error: null });
  });

  await test('submitVideoGeneration fails safely on an HTTP error, never fabricates an id', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(400, { error: 'invalid promptImage' }));

    const result = await runway.submitVideoGeneration(
      { imageDataUri: 'not-a-real-image', prompt: 'x', durationSeconds: 5, ratio: '16:9' },
      fetchImpl
    );

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.externalJobId, null);
    assert.ok(result.error.includes('400'));
  });

  await test('submitVideoGeneration fails safely when the response has no task id', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, {}));

    const result = await runway.submitVideoGeneration({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, fetchImpl);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.externalJobId, null);
  });

  await test('submitVideoGeneration fails safely on a network error', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNRESET');
    });

    const result = await runway.submitVideoGeneration({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, fetchImpl);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'ECONNRESET');
  });

  await test('submitVideoGeneration fails safely when RUNWAYML_API_SECRET is missing', async () => {
    const original = process.env.RUNWAYML_API_SECRET;
    delete process.env.RUNWAYML_API_SECRET;
    try {
      const fetchImpl = fakeFetch(async () => {
        throw new Error('should never be called without a key');
      });
      const result = await runway.submitVideoGeneration({ imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '16:9' }, fetchImpl);
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('RUNWAYML_API_SECRET'));
    } finally {
      process.env.RUNWAYML_API_SECRET = original;
    }
  });

  await test('checkVideoGenerationStatus maps PENDING/RUNNING to processing', async () => {
    for (const runwayStatus of ['PENDING', 'RUNNING', 'THROTTLED']) {
      const fetchImpl = fakeFetch(async (url) => {
        assert.ok(url.endsWith('/tasks/task_123'));
        return jsonResponse(200, { id: 'task_123', status: runwayStatus });
      });
      const result = await runway.checkVideoGenerationStatus({ externalJobId: 'task_123' }, fetchImpl);
      assert.strictEqual(result.status, 'processing', `expected ${runwayStatus} to map to processing`);
      assert.strictEqual(result.error, null);
    }
  });

  await test('checkVideoGenerationStatus maps SUCCEEDED to completed', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'SUCCEEDED', output: ['https://example.test/clip.mp4'] }));
    const result = await runway.checkVideoGenerationStatus({ externalJobId: 'task_123' }, fetchImpl);
    assert.strictEqual(result.status, 'completed');
  });

  await test('checkVideoGenerationStatus maps FAILED to failed with a reason', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'FAILED', failure: 'content moderation' }));
    const result = await runway.checkVideoGenerationStatus({ externalJobId: 'task_123' }, fetchImpl);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'content moderation');
  });

  await test('retrieveGeneratedVideo returns a real URL only when SUCCEEDED with output', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'SUCCEEDED', output: ['https://example.test/clip.mp4'] }));
    const result = await runway.retrieveGeneratedVideo({ externalJobId: 'task_123' }, fetchImpl);
    assert.deepStrictEqual(result, { status: 'completed', url: 'https://example.test/clip.mp4', error: null });
  });

  await test('retrieveGeneratedVideo never fabricates a URL when SUCCEEDED but output is empty', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'SUCCEEDED', output: [] }));
    const result = await runway.retrieveGeneratedVideo({ externalJobId: 'task_123' }, fetchImpl);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.url, null);
    assert.ok(result.error);
  });

  await test('retrieveGeneratedVideo reports processing (no url) while still running', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'RUNNING' }));
    const result = await runway.retrieveGeneratedVideo({ externalJobId: 'task_123' }, fetchImpl);
    assert.strictEqual(result.status, 'processing');
    assert.strictEqual(result.url, null);
  });

  await test('retrieveGeneratedVideo reports failed (no url) when the task failed', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(200, { id: 'task_123', status: 'FAILED', failure: 'timeout' }));
    const result = await runway.retrieveGeneratedVideo({ externalJobId: 'task_123' }, fetchImpl);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.url, null);
    assert.strictEqual(result.error, 'timeout');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll Runway provider tests passed (no real API calls made, no credits spent).');
  }
}

main();
