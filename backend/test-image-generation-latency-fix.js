// Regression test for the real production failure: the generateSceneImages
// Agent tool (and the /generate-images REST route, which shares the same
// underlying function) generates images synchronously, one at a time, in
// real time, inside a single request/response cycle. At IMAGE_QUALITY
// 'high', a single gpt-image-2 generation can take up to several minutes —
// for a job with more than one scene, that easily exceeds a serverless
// function's execution time limit, especially when invoked from
// POST /api/agent, where the time budget is also shared with Claude's own
// round-trips. A platform-level timeout kills the request before this
// module's own error handling ever runs, which is what made the failure
// look like a silent, unexplained "image generation unavailable" instead
// of a clear, logged error.
//
// This test pins the fix (IMAGE_QUALITY must not be 'high') as a durable
// regression guard, and proves the new diagnostic start/finish logging
// fires correctly and never contains the API key or any other secret —
// mirroring the same diagnostic-logging pattern already applied to the
// Runway integration. Uses a local mock OpenAI images server (no real API
// calls, no cost). Run with:
//   node test-image-generation-latency-fix.js
// or:
//   npm run test:image-generation-latency-fix

const http = require('http');
const assert = require('assert');

const imageGeneration = require('./image-generation');

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

function startMockOpenAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
  await test('IMAGE_QUALITY is not the pathologically slow "high" setting', () => {
    assert.notStrictEqual(
      imageGeneration.IMAGE_QUALITY,
      'high',
      '"high" quality gpt-image-2 generation can take minutes per image and risks exceeding a ' +
        'serverless request timeout, especially for multi-scene jobs generated via the Agent tool'
    );
    assert.ok(
      ['low', 'medium'].includes(imageGeneration.IMAGE_QUALITY),
      'expected a faster quality setting (low or medium)'
    );
  });

  const mockServer = await startMockOpenAi();
  const port = mockServer.address().port;
  process.env.OPENAI_API_KEY = 'super-secret-test-key-should-never-appear';
  process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;

  await test('generateImagesForPrompts logs a clear start/finish diagnostic, and never logs the API key', async () => {
    const originalConsoleLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args.join(' '));

    try {
      await imageGeneration.generateImagesForPrompts({
        imagePrompts: ['Scene A', 'Scene B'],
        characters: ['Mira'],
        existingImages: [],
      });
    } finally {
      console.log = originalConsoleLog;
    }

    const startLine = logged.find((line) => line.includes('Starting image generation'));
    const finishLine = logged.find((line) => line.includes('Finished image generation'));

    assert.ok(startLine, 'expected a "Starting image generation" log line');
    assert.ok(startLine.includes('2 prompt'), 'start log should mention the number of prompts');
    assert.ok(startLine.includes('quality=medium') || startLine.includes('quality=low'), 'start log should show the configured quality');
    assert.ok(finishLine, 'expected a "Finished image generation" log line');
    assert.ok(finishLine.includes('2 completed'), 'finish log should summarize completed count');

    const allLogText = logged.join(' ');
    assert.ok(!allLogText.includes('super-secret-test-key-should-never-appear'), 'logs must never contain the API key');
    assert.ok(!allLogText.includes('Bearer'), 'logs must never contain an Authorization header');
  });

  await test('a real generation failure is still logged clearly by prompt, not silently swallowed', async () => {
    mockServer.close();
    // No listener on this port anymore -> every request fails with a
    // network error, simulating a real failure reaching image-generation.js
    // (as opposed to a platform-level timeout, which never reaches here at
    // all -- this proves the code's OWN error path still works correctly).
    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.join(' '));

    let images;
    try {
      images = await imageGeneration.generateImagesForPrompts({
        imagePrompts: ['Scene C'],
        characters: [],
        existingImages: [],
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.strictEqual(images[0].status, 'failed');
    assert.ok(images[0].error, 'a real failure must carry a real error message, never a fabricated success');
    assert.ok(loggedErrors.some((line) => line.includes('OpenAI image generation error')));
    assert.ok(!loggedErrors.join(' ').includes('super-secret-test-key-should-never-appear'));
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll image-generation latency-fix tests passed.');
  }
}

main();
