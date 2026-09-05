// Regression test for the real production bug: generateSceneImage() passed
// a single reference image to OpenAI's images.edit() wrapped in an array
// (image: [referenceFile]). The SDK's TypeScript types allow an array, but
// the real OpenAI API can reject it with "400 Invalid type for 'image':
// expected a file, but got an array instead" — a documented mismatch
// between the SDK's types and actual API behavior (openai-node issue
// #1492). Since every scene after the first always takes this branch (it
// references the previous scene's image for character consistency), this
// deterministically broke image generation for any job with more than one
// scene, independent of the earlier IMAGE_QUALITY/timeout fix.
//
// Every mock OpenAI server used elsewhere in this project's test suite
// accepts any request body unconditionally, so none of them can actually
// reproduce OpenAI's real array-vs-single-file validation — that's exactly
// why this bug passed ~40 existing tests. Rather than give false
// confidence with a mock that can't replicate real API behavior this
// precisely, the first test below asserts the exact fix directly against
// the source (image is passed as a bare value, never wrapped in an
// array). The second test proves the fix doesn't break the existing
// multi-scene reference-chaining behavior end-to-end (mocked OpenAI, zero
// real API calls/cost).
//
// Run with:
//   node test-image-edit-reference-shape.js
// or:
//   npm run test:image-edit-reference-shape

const fs = require('fs');
const path = require('path');
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
  await test('generateSceneImage passes a single reference image directly, never wrapped in an array', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'image-generation.js'), 'utf8');

    assert.ok(
      !source.includes('image: [referenceFile]'),
      'image must never be passed as an array — the real OpenAI API rejects this for a single file'
    );
    assert.ok(
      /image:\s*referenceFile\s*,/.test(source),
      'expected the fixed form: image passed as a bare value (image: referenceFile)'
    );
  });

  const mockServer = await startMockOpenAi();
  const port = mockServer.address().port;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;

  await test('a multi-scene job still generates all images end-to-end, including the reference/edit path for later scenes', async () => {
    const images = await imageGeneration.generateImagesForPrompts({
      imagePrompts: ['Scene 1: establishing shot', 'Scene 2: uses the previous scene as a reference'],
      characters: ['Mira'],
      existingImages: [],
    });

    assert.strictEqual(images.length, 2);
    assert.ok(images.every((image) => image.status === 'completed'), 'both scenes (generate path and edit/reference path) must succeed');
    assert.ok(images.every((image) => image.url && image.url.startsWith('data:image/')));
  });

  mockServer.close();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll image-edit reference-shape tests passed.');
  }
}

main();
