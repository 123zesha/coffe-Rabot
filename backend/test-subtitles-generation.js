// Tests for backend/subtitles-generation.js — the optional Subtitles
// feature's text half. Covers: decoding the voice-over's data: URI,
// honoring OpenAI's response_format: 'srt' (verified against the installed
// `openai` SDK's own type definitions — a non-JSON content-type response is
// returned as a plain string by the SDK's default response parser), and
// honest failure handling for missing/invalid audio and API errors. The one
// real dependency (an OpenAI transcription call) is always a local mock
// HTTP server — no real network call to OpenAI is ever made, no cost.
// Run with:
//   node test-subtitles-generation.js
// or:
//   npm run test:subtitles-generation

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

// A tiny, real MP3 header isn't needed — the mock transcription server never
// actually decodes the uploaded audio, only the real OpenAI API does. What
// matters here is that a real multipart upload reaches the mock server at
// all, proving dataUriToAudioFile actually produced a real uploadable file.
const FAKE_MP3_BASE64 = Buffer.from('fake mp3 bytes for testing only').toString('base64');
const VOICEOVER_DATA_URI = `data:audio/mpeg;base64,${FAKE_MP3_BASE64}`;

const SAMPLE_SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,000 --> 00:00:04,000\nWelcome to the show.\n';

function startMockOpenAiTranscription(respond) {
  return startMockServer((req, res) => {
    if (!req.url.startsWith('/audio/transcriptions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      respond(body, res, req);
    });
  });
}

async function main() {
  function freshModule() {
    delete require.cache[require.resolve('./subtitles-generation')];
    return require('./subtitles-generation');
  }

  await test('generateSubtitles refuses — before any OpenAI call — when there is no real voice-over url', async () => {
    let requestCount = 0;
    const server = await startMockOpenAiTranscription((body, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SAMPLE_SRT);
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      for (const voiceoverUrl of [null, undefined, '', 'not-a-data-uri', 'https://example.com/voice.mp3']) {
        const result = await fresh.generateSubtitles({ voiceoverUrl });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.content, null);
        assert.ok(result.error, `expected an error message for voiceoverUrl=${JSON.stringify(voiceoverUrl)}`);
      }
      assert.strictEqual(requestCount, 0, 'no OpenAI call may happen without a real voice-over data: URI');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles refuses — before any OpenAI call — when the data: URI decodes to zero bytes', async () => {
    let requestCount = 0;
    const server = await startMockOpenAiTranscription((body, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SAMPLE_SRT);
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateSubtitles({ voiceoverUrl: 'data:audio/mpeg;base64,' });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(requestCount, 0);
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles returns the real .srt content OpenAI returns, requesting whisper-1 with response_format srt', async () => {
    let receivedModel = null;
    let receivedResponseFormat = null;
    const server = await startMockOpenAiTranscription((body, res) => {
      const text = body.toString('utf8');
      const modelMatch = text.match(/name="model"\r\n\r\n([^\r\n]+)/);
      const formatMatch = text.match(/name="response_format"\r\n\r\n([^\r\n]+)/);
      receivedModel = modelMatch ? modelMatch[1] : null;
      receivedResponseFormat = formatMatch ? formatMatch[1] : null;

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SAMPLE_SRT);
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateSubtitles({ voiceoverUrl: VOICEOVER_DATA_URI });

      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.format, 'srt');
      assert.strictEqual(result.content, SAMPLE_SRT.trim());
      assert.strictEqual(result.error, null);
      assert.strictEqual(receivedModel, fresh.TRANSCRIPTION_MODEL);
      assert.strictEqual(receivedResponseFormat, 'srt');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles fails honestly (never fabricates) when the transcription call returns empty content', async () => {
    const server = await startMockOpenAiTranscription((body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('   ');
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateSubtitles({ voiceoverUrl: VOICEOVER_DATA_URI });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.content, null);
      assert.ok(result.error);
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles returns a real failure, never a fabricated .srt, when the OpenAI call itself fails', async () => {
    const server = await startMockOpenAiTranscription((body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated OpenAI transcription outage' } }));
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateSubtitles({ voiceoverUrl: VOICEOVER_DATA_URI });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.content, null);
      assert.ok(result.error);
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles throws a clear error (not a silent failure) when OPENAI_API_KEY is missing at call time', async () => {
    const fresh = freshModule();
    delete process.env.OPENAI_API_KEY;

    const result = await fresh.generateSubtitles({ voiceoverUrl: VOICEOVER_DATA_URI });
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.toLowerCase().includes('openai_api_key'));
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll subtitles-generation tests passed.');
  }
}

main();
