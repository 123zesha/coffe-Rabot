// Tests for job.outputFormat support ("Horizontal 16:9" / "Vertical 9:16" /
// "Square 1:1") flowing consistently through image generation
// (backend/image-generation.js) and Runway video generation
// (backend/video-generation.js). Final-video pixel-dimension correctness
// (the ffmpeg assembly step) is covered separately in
// test-video-assembly.js, using real local ffmpeg — no paid API involved
// there either. Every OpenAI/Runway call here is a local mock HTTP server,
// or (for video-generation.js) an in-process fake provider object, exactly
// like test-video-generation.js already uses — no real network call to
// OpenAI or Runway is ever made, no cost.
//
// Run with:
//   node test-output-format.js
// or:
//   npm run test:output-format

const http = require('http');
const assert = require('assert');

const videoGeneration = require('./video-generation');
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

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

// Extracts one field's value from a multipart/form-data body (used by
// images.edit, which uploads a reference file) — same technique already
// used in test-subtitles-generation.js for the transcription endpoint's
// multipart body.
function extractMultipartField(body, fieldName) {
  const match = body.match(new RegExp(`name="${fieldName}"\\r\\n\\r\\n([^\\r\\n]+)`));
  return match ? match[1] : null;
}

const FAKE_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function startMockOpenAiImages(onRequest) {
  return startMockServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let size = null;
      let prompt = null;
      if (req.url.startsWith('/images/generations')) {
        try {
          const json = JSON.parse(bodyText);
          size = json.size;
          prompt = json.prompt;
        } catch (error) {
          // ignore
        }
      } else {
        size = extractMultipartField(bodyText, 'size');
        prompt = extractMultipartField(bodyText, 'prompt');
      }
      onRequest({ url: req.url, size, prompt });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: FAKE_IMAGE_B64 }] }));
    });
  });
}

async function main() {
  // image-generation.js caches its OpenAI client at module scope (reading
  // OPENAI_BASE_URL only once, at first construction) — each test below
  // starts its OWN mock server on a new port, so the require cache must be
  // busted before each one; otherwise a later test would keep hitting an
  // earlier test's already-closed server via the stale cached client.
  function freshImageGeneration() {
    delete require.cache[require.resolve('./image-generation')];
    return require('./image-generation');
  }

  // --- image-generation.js: size + prompt framing per outputFormat ---

  await test('generateImagesForPrompts requests the correct OpenAI image size for each outputFormat', async () => {
    const requests = [];
    const server = await startMockOpenAiImages((info) => requests.push(info));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const imageGen = freshImageGeneration();

    try {
      for (const [outputFormat, expectedSize] of [
        ['horizontal', '1536x1024'],
        ['vertical', '1024x1536'],
        ['square', '1024x1024'],
      ]) {
        requests.length = 0;
        const images = await imageGen.generateImagesForPrompts({
          imagePrompts: ['A lighthouse at dusk'],
          characters: [],
          existingImages: [],
          outputFormat,
        });
        assert.strictEqual(images[0].status, 'completed', JSON.stringify(images));
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].size, expectedSize, `outputFormat=${outputFormat}`);
        assert.strictEqual(images[0].outputFormat, outputFormat, 'the completed image must record which format it was generated at');
      }
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateImagesForPrompts defaults to horizontal when outputFormat is omitted (no regression)', async () => {
    const requests = [];
    const server = await startMockOpenAiImages((info) => requests.push(info));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const imageGen = freshImageGeneration();

    try {
      const images = await imageGen.generateImagesForPrompts({
        imagePrompts: ['A lighthouse at dusk'],
        characters: [],
        existingImages: [],
      });
      assert.strictEqual(requests[0].size, imageGen.IMAGE_SIZE, 'must match the original, pre-existing default size exactly');
      assert.strictEqual(images[0].outputFormat, 'horizontal');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateImagesForPrompts prompts a framing directive matching the requested outputFormat', async () => {
    const requests = [];
    const server = await startMockOpenAiImages((info) => requests.push(info));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const imageGen = freshImageGeneration();

    try {
      requests.length = 0;
      await imageGen.generateImagesForPrompts({
        imagePrompts: ['A lighthouse at dusk'],
        characters: [],
        existingImages: [],
        outputFormat: 'vertical',
      });
      assert.ok(requests[0].prompt.toLowerCase().includes('vertical portrait'), requests[0].prompt);
      assert.ok(!requests[0].prompt.toLowerCase().includes('widescreen'), 'a vertical request must not still say widescreen');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateImagesForPrompts reuses an already-completed image only when its outputFormat still matches', async () => {
    const requests = [];
    const server = await startMockOpenAiImages((info) => requests.push(info));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const imageGen = freshImageGeneration();

    try {
      const existingImages = [
        { prompt: 'A lighthouse at dusk', url: 'data:image/png;base64,already', status: 'completed', outputFormat: 'horizontal' },
      ];

      requests.length = 0;
      const sameFormat = await imageGen.generateImagesForPrompts({
        imagePrompts: ['A lighthouse at dusk'],
        characters: [],
        existingImages,
        outputFormat: 'horizontal',
      });
      assert.strictEqual(requests.length, 0, 'an unchanged outputFormat must reuse the existing image, no new OpenAI call');
      assert.strictEqual(sameFormat[0].url, 'data:image/png;base64,already');

      requests.length = 0;
      const changedFormat = await imageGen.generateImagesForPrompts({
        imagePrompts: ['A lighthouse at dusk'],
        characters: [],
        existingImages,
        outputFormat: 'vertical',
      });
      assert.strictEqual(requests.length, 1, 'a changed outputFormat must trigger a real, fresh generation — never reuse the wrong-shaped image');
      assert.strictEqual(requests[0].size, '1024x1536');
      assert.strictEqual(changedFormat[0].outputFormat, 'vertical');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateImagesForPrompts treats a legacy image with no outputFormat as horizontal (real historical default)', async () => {
    const requests = [];
    const server = await startMockOpenAiImages((info) => requests.push(info));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const imageGen = freshImageGeneration();

    try {
      const legacyImages = [{ prompt: 'A lighthouse at dusk', url: 'data:image/png;base64,legacy', status: 'completed' }];

      requests.length = 0;
      const result = await imageGen.generateImagesForPrompts({
        imagePrompts: ['A lighthouse at dusk'],
        characters: [],
        existingImages: legacyImages,
        outputFormat: 'horizontal',
      });
      assert.strictEqual(requests.length, 0, 'a legacy image with no recorded format must be treated as horizontal, not regenerated for a default-format request');
      assert.strictEqual(result[0].url, 'data:image/png;base64,legacy');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  // --- video-generation.js: Runway ratio per outputFormat ---

  function fakeProvider(overrides) {
    return {
      name: 'fake',
      async submitVideoGeneration() {
        return { status: 'processing', externalJobId: 'ext-1', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'processing', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'failed', url: null, error: 'not reached' };
      },
      ...overrides,
    };
  }

  await test('generateVideoForScenes submits the correct Runway ratio for each outputFormat', async () => {
    for (const [outputFormat, expectedRatio] of [
      ['horizontal', '1280:720'],
      ['vertical', '720:1280'],
      ['square', '960:960'],
    ]) {
      let receivedRatio = null;
      const provider = fakeProvider({
        async submitVideoGeneration({ ratio }) {
          receivedRatio = ratio;
          return { status: 'processing', externalJobId: 'ext-1', clips: [] };
        },
      });

      await videoGeneration.generateVideoForScenes(
        {
          videoPrompts: ['Pan across the lighthouse'],
          images: [{ status: 'completed', url: 'data:image/png;base64,x' }],
          existingClips: [],
          outputFormat,
        },
        provider
      );

      assert.strictEqual(receivedRatio, expectedRatio, `outputFormat=${outputFormat}`);
    }
  });

  await test('generateVideoForScenes defaults to the original 16:9 ratio when outputFormat is omitted (no regression)', async () => {
    let receivedRatio = null;
    const provider = fakeProvider({
      async submitVideoGeneration({ ratio }) {
        receivedRatio = ratio;
        return { status: 'processing', externalJobId: 'ext-1', clips: [] };
      },
    });

    await videoGeneration.generateVideoForScenes(
      {
        videoPrompts: ['Pan across the lighthouse'],
        images: [{ status: 'completed', url: 'data:image/png;base64,x' }],
        existingClips: [],
      },
      provider
    );

    assert.strictEqual(receivedRatio, videoGeneration.DEFAULT_ASPECT_RATIO);
  });

  await test('an explicit ratio still overrides outputFormat (existing direct-ratio callers keep working)', async () => {
    let receivedRatio = null;
    const provider = fakeProvider({
      async submitVideoGeneration({ ratio }) {
        receivedRatio = ratio;
        return { status: 'processing', externalJobId: 'ext-1', clips: [] };
      },
    });

    await videoGeneration.generateVideoForScenes(
      {
        videoPrompts: ['Pan across the lighthouse'],
        images: [{ status: 'completed', url: 'data:image/png;base64,x' }],
        existingClips: [],
        outputFormat: 'vertical',
        ratio: '1584:672',
      },
      provider
    );

    assert.strictEqual(receivedRatio, '1584:672', 'an explicit ratio must win over outputFormat');
  });

  await test('generateClip regenerates for real when an already-completed clip\'s ratio no longer matches the desired one', async () => {
    let submitCalls = 0;
    const provider = fakeProvider({
      async submitVideoGeneration() {
        submitCalls++;
        return { status: 'processing', externalJobId: 'ext-new', clips: [] };
      },
      async checkVideoGenerationStatus() {
        return { status: 'completed', clips: [] };
      },
      async retrieveGeneratedVideo() {
        return { status: 'completed', url: 'data:video/mp4;base64,bmV3Y2xpcA==' };
      },
    });

    const existingClip = {
      status: 'completed',
      externalJobId: 'ext-old',
      url: '/generated/scene-clip-job-3-0-old.mp4',
      stored: true,
      error: null,
      attempts: 1,
      ratio: '1280:720',
    };

    const result = await videoGeneration.generateClip(
      { imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '720:1280', existingClip, jobId: 'job-3', sceneIndex: 0 },
      provider
    );

    assert.strictEqual(submitCalls, 1, 'a real format change must trigger a real, fresh Runway submission');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.ratio, '720:1280');
  });

  await test('generateClip reuses an already-completed clip unchanged when its ratio still matches (no duplicate paid call)', async () => {
    let submitCalls = 0;
    const provider = fakeProvider({
      async submitVideoGeneration() {
        submitCalls++;
        return { status: 'processing', externalJobId: 'should-not-happen', clips: [] };
      },
    });

    const existingClip = {
      status: 'completed',
      externalJobId: 'ext-old',
      url: '/generated/scene-clip-job-4-0-old.mp4',
      stored: true,
      error: null,
      attempts: 1,
      ratio: '1280:720',
    };

    const result = await videoGeneration.generateClip(
      { imageDataUri: 'x', prompt: 'x', durationSeconds: 5, ratio: '1280:720', existingClip, jobId: 'job-4', sceneIndex: 0 },
      provider
    );

    assert.strictEqual(submitCalls, 0);
    assert.deepStrictEqual(result, existingClip);
  });

  // --- job-store.js: the shared format list/default ---

  await test('job-store exposes OUTPUT_FORMATS/DEFAULT_OUTPUT_FORMAT and a new job defaults to horizontal', async () => {
    assert.deepStrictEqual(jobStore.OUTPUT_FORMATS, ['horizontal', 'vertical', 'square']);
    assert.strictEqual(jobStore.DEFAULT_OUTPUT_FORMAT, 'horizontal');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll output-format tests passed.');
  }
}

main();
