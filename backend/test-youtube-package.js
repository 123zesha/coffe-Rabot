// Tests for backend/youtube-package.js — the text half of the optional
// "YouTube Publishing Package" feature. Covers: refusing without a script,
// the real Claude call's JSON-parsing/sanitization, and honest failure
// handling for malformed/incomplete responses and API errors. The one real
// dependency (a Claude call) is always a local mock HTTP server — no real
// network call to Anthropic is ever made, no cost. Run with:
//   node test-youtube-package.js
// or:
//   npm run test:youtube-package

const http = require('http');
const assert = require('assert');

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

function startMockAnthropic(respond) {
  return startMockServer((req, res) => {
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
      respond(body, res);
    });
  });
}

const REAL_SCRIPT =
  'Welcome to this video about the quiet lighthouse at the edge of town. ' +
  'For a hundred years it has guided ships safely home through fog and storm. ' +
  'Tonight, we look at the people who kept its light burning, generation after generation.';

const VALID_JSON_REPLY = JSON.stringify({
  titles: ['The Lighthouse That Never Sleeps', 'A Century of Light', 'Guardians of the Shore'],
  description: 'A short documentary about the lighthouse keepers who kept the light burning for a century.',
  tags: ['lighthouse', 'documentary', 'history'],
  thumbnailConcept: 'A glowing lighthouse at dusk against a stormy sky.',
  thumbnailText: 'A CENTURY OF LIGHT',
});

async function main() {
  const { generateYoutubeTextPackage, extractJsonObject } = require('./youtube-package');

  await test('extractJsonObject parses a plain JSON object', () => {
    const parsed = extractJsonObject('{"a": 1, "b": "two"}');
    assert.deepStrictEqual(parsed, { a: 1, b: 'two' });
  });

  await test('extractJsonObject extracts JSON even with surrounding prose/fences', () => {
    const parsed = extractJsonObject('Here you go:\n```json\n{"a": 1}\n```\nHope that helps!');
    assert.deepStrictEqual(parsed, { a: 1 });
  });

  await test('extractJsonObject returns null for text with no JSON object at all', () => {
    assert.strictEqual(extractJsonObject('no json here'), null);
    assert.strictEqual(extractJsonObject(''), null);
    assert.strictEqual(extractJsonObject(null), null);
  });

  await test('extractJsonObject returns null for malformed JSON', () => {
    assert.strictEqual(extractJsonObject('{"a": 1,}'), null);
  });

  // youtube-package.js lazily caches its Anthropic client at module scope
  // (same design as reference-video.js), so each test that points
  // ANTHROPIC_BASE_URL at a fresh mock server on a new port must also bust
  // the require cache first — otherwise a later test would keep hitting an
  // earlier test's already-closed server via the stale cached client.
  function freshModule() {
    delete require.cache[require.resolve('./youtube-package')];
    return require('./youtube-package');
  }

  await test('generateYoutubeTextPackage refuses — before any Claude call — when there is no script', async () => {
    let requestCount = 0;
    const server = await startMockAnthropic((body, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: VALID_JSON_REPLY }] }));
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({ topic: 'Lighthouses', script: '   ' });
      assert.strictEqual(requestCount, 0, 'no script means no real Claude call');
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.toLowerCase().includes('script'));
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  await test('generateYoutubeTextPackage returns a real, sanitized package from a valid JSON reply', async () => {
    let receivedPrompt = null;
    const server = await startMockAnthropic((body, res) => {
      receivedPrompt = body && Array.isArray(body.messages) ? body.messages[0].content : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: VALID_JSON_REPLY }] }));
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({
        topic: 'The old lighthouse',
        duration: '3-5',
        language: 'English',
        storyStyle: 'documentary',
        script: REAL_SCRIPT,
      });

      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.titles.length, 3);
      assert.ok(result.titles.includes('A Century of Light'));
      assert.ok(result.description.includes('lighthouse keepers'));
      assert.deepStrictEqual(result.tags, ['lighthouse', 'documentary', 'history']);
      assert.ok(result.thumbnailConcept.includes('glowing lighthouse'));
      assert.strictEqual(result.thumbnailText, 'A CENTURY OF LIGHT');

      assert.ok(receivedPrompt.includes(REAL_SCRIPT), 'the real final script must reach the prompt');
      assert.ok(receivedPrompt.includes('The old lighthouse'));
      assert.ok(!receivedPrompt.toLowerCase().includes('reference video'), 'must never mention a reference video at all');
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  await test('generateYoutubeTextPackage caps titles/tags to their maximum count', async () => {
    const server = await startMockAnthropic((body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                titles: ['One', 'Two', 'Three', 'Four'],
                description: 'A real description.',
                tags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
                thumbnailConcept: 'A concept.',
                thumbnailText: 'TEXT',
              }),
            },
          ],
        })
      );
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({ script: REAL_SCRIPT });
      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.titles.length, 3, 'titles must be capped at 3');
      assert.strictEqual(result.tags.length, 20, 'tags must be capped at 20');
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  await test('generateYoutubeTextPackage fails honestly (never fabricates) when Claude returns no valid JSON', async () => {
    const server = await startMockAnthropic((body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Sorry, I cannot help with that.' }] }));
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({ script: REAL_SCRIPT });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.titles.length, 0);
      assert.strictEqual(result.description, null);
      assert.ok(result.error);
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  await test('generateYoutubeTextPackage fails honestly when the JSON is missing required parts', async () => {
    const server = await startMockAnthropic((body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ titles: [], description: '', tags: [] }) }],
        })
      );
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({ script: REAL_SCRIPT });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.toLowerCase().includes('incomplete'));
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  await test('generateYoutubeTextPackage returns a real failure, never a fabricated package, when the Claude call itself fails', async () => {
    const server = await startMockAnthropic((body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated Anthropic outage' } }));
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateYoutubeTextPackage({ script: REAL_SCRIPT });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.titles.length, 0);
      assert.ok(result.error);
    } finally {
      server.close();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll youtube-package tests passed.');
  }
}

main();
