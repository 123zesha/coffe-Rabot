// Tests for backend/subtitles-generation.js — the optional Subtitles
// feature's text half. Covers: reading the voice-over's real audio bytes
// (a data: URI, a /generated/ local reference, or a real http(s) URL —
// every shape voiceover-generation.js's storage can produce), honoring
// OpenAI's response_format: 'srt' (verified against the installed
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
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const assert = require('assert');
const { GENERATED_DIR } = require('./video-storage');
const { ffmpegPath } = require('./video-assembly');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || '').toString().slice(-800) || error.message));
      resolve();
    });
  });
}

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

  await test('generateSubtitles refuses — before any OpenAI call — when there is no real voice-over reference', async () => {
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
      for (const voiceoverUrl of [null, undefined, '', 'not-a-real-reference', 'ftp://example.com/voice.mp3']) {
        const result = await fresh.generateSubtitles({ voiceoverUrl });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.content, null);
        assert.ok(result.error, `expected an error message for voiceoverUrl=${JSON.stringify(voiceoverUrl)}`);
      }
      assert.strictEqual(requestCount, 0, 'no OpenAI call may happen without a real, readable voice-over reference');
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles refuses — before any OpenAI call — when a /generated/ local reference does not exist on disk', async () => {
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
      const result = await fresh.generateSubtitles({ voiceoverUrl: '/generated/does-not-exist.mp3' });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(requestCount, 0);
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

  await test('generateSubtitles transcribes real audio served from a real https(-like) URL (Vercel Blob production shape)', async () => {
    let audioRequestCount = 0;
    const audioServer = await startMockServer((req, res) => {
      audioRequestCount++;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('fake mp3 bytes served over http'));
    });
    const transcriptionServer = await startMockOpenAiTranscription((body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SAMPLE_SRT);
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${transcriptionServer.address().port}`;
    const fresh = freshModule();

    try {
      const voiceoverUrl = `http://localhost:${audioServer.address().port}/voiceover.mp3`;
      const result = await fresh.generateSubtitles({ voiceoverUrl });

      assert.strictEqual(audioRequestCount, 1, 'expected exactly one download of the remote-stored voice-over audio');
      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.content, SAMPLE_SRT.trim());
    } finally {
      audioServer.close();
      transcriptionServer.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  await test('generateSubtitles transcribes real audio read from a /generated/ local reference (no-Blob-token dev/test fallback)', async () => {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const filename = `voiceover-test-${Date.now()}.mp3`;
    fs.writeFileSync(path.join(GENERATED_DIR, filename), Buffer.from('fake mp3 bytes on local disk'));

    const server = await startMockOpenAiTranscription((body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SAMPLE_SRT);
    });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;
    const fresh = freshModule();

    try {
      const result = await fresh.generateSubtitles({ voiceoverUrl: `/generated/${filename}` });
      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.content, SAMPLE_SRT.trim());
    } finally {
      server.close();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
      fs.rmSync(path.join(GENERATED_DIR, filename), { force: true });
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

  // --- Long-video support: chunked transcription past Whisper's 25MB
  // per-request limit (see MAX_WHISPER_FILE_BYTES). A real, uncompressed
  // WAV fixture reaches that size in well under a real production video's
  // full duration, so this exercises the real ffmpeg splitting + real
  // multi-call transcription + real timestamp-offset merge quickly,
  // without needing an actual multi-minute audio render.
  await test('generateSubtitles splits audio over MAX_WHISPER_FILE_BYTES into real segments and merges transcriptions with correctly offset timestamps', async () => {
    const fresh = freshModule();
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const filename = `long-voiceover-test-${Date.now()}.wav`;
    const audioPath = path.join(GENERATED_DIR, filename);

    try {
      // 48kHz/16-bit/stereo PCM WAV = 192,000 bytes/s — a 150s fixture is
      // ~28.8MB, comfortably over the 24MB threshold, so this always needs
      // real splitting regardless of the exact encoder output size.
      const totalSeconds = 150;
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${totalSeconds}`, '-ar', '48000', '-ac', '2', audioPath]);
      const audioBuffer = fs.readFileSync(audioPath);
      assert.ok(audioBuffer.length > fresh.MAX_WHISPER_FILE_BYTES, 'test fixture must exceed the chunking threshold');
      const expectedSegments = Math.ceil(audioBuffer.length / fresh.MAX_WHISPER_FILE_BYTES);
      assert.ok(expectedSegments >= 2, 'test fixture should need at least 2 real segments to be a meaningful test');

      let requestCount = 0;
      const seenContentLengths = [];
      const server = await startMockOpenAiTranscription((body, res) => {
        requestCount++;
        seenContentLengths.push(body.length);
        // Every real segment transcribes to one cue at its OWN local start
        // — the module under test is responsible for shifting this by the
        // segment's real offset in the original audio.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,500 --> 00:00:01,500\nSegment audio.\n');
      });
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;

      try {
        const result = await fresh.generateSubtitles({ voiceoverUrl: `/generated/${filename}` });
        assert.strictEqual(result.status, 'completed', JSON.stringify(result));
        assert.strictEqual(requestCount, expectedSegments, 'expected exactly one real transcription call per segment');
        assert.ok(
          seenContentLengths.every((len) => len < fresh.MAX_WHISPER_FILE_BYTES),
          'every uploaded segment must itself be under the size limit'
        );

        const { parseSrt } = require('./simple-story-video');
        const cues = parseSrt(result.content);
        assert.strictEqual(cues.length, expectedSegments, 'expected exactly one merged cue per real segment');
        assert.deepStrictEqual(
          [...cues].sort((a, b) => a.start - b.start).map((c) => c.start),
          cues.map((c) => c.start),
          'merged cues must be sorted by their real, offset-shifted start time'
        );
        // If offsets were dropped (a real bug this test is designed to
        // catch), every cue would incorrectly land at ~0.5s instead of
        // being spread across the fixture's real 150s duration — with
        // expectedSegments roughly-equal segments, the last one starts
        // around (expectedSegments-1)/expectedSegments of the way through.
        const expectedMinLastStart = (totalSeconds * (expectedSegments - 1)) / expectedSegments - 5;
        assert.ok(
          cues[cues.length - 1].start > expectedMinLastStart,
          `expected the last cue's start (${cues[cues.length - 1].start}) to reflect its real, late position in the ${totalSeconds}s audio`
        );
      } finally {
        server.close();
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
      }
    } finally {
      fs.rmSync(audioPath, { force: true });
    }
  });

  await test('generateSubtitles fails honestly (never fabricates) when a chunked segment transcription returns empty content', async () => {
    const fresh = freshModule();
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const filename = `long-voiceover-empty-test-${Date.now()}.wav`;
    const audioPath = path.join(GENERATED_DIR, filename);

    try {
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=150', '-ar', '48000', '-ac', '2', audioPath]);

      const server = await startMockOpenAiTranscription((body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(''); // every segment transcribes to nothing usable
      });
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.OPENAI_BASE_URL = `http://localhost:${server.address().port}`;

      try {
        const result = await fresh.generateSubtitles({ voiceoverUrl: `/generated/${filename}` });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.content, null);
        assert.ok(result.error);
      } finally {
        server.close();
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
      }
    } finally {
      fs.rmSync(audioPath, { force: true });
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll subtitles-generation tests passed.');
  }
}

main();
