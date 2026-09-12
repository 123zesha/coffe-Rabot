// Tests for backend/reference-video.js — "Reference Video / Inspiration
// Mode". Covers: YouTube URL/video-ID parsing, the free keyless oEmbed
// metadata fetch, the best-effort caption-track scrape, and the full
// analyzeReferenceVideo orchestration (including its one real dependency,
// a Claude summarization call). Every external call here — oEmbed, the
// watch-page scrape, and Claude — is a local mock HTTP server; no real
// network call to YouTube or Anthropic is ever made, no cost. Run with:
//   node test-reference-video.js
// or:
//   npm run test:reference-video

const http = require('http');
const assert = require('assert');

const {
  extractYouTubeVideoId,
  fetchOEmbedMetadata,
  fetchTranscriptBestEffort,
  analyzeReferenceVideo,
} = require('./reference-video');

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

async function main() {
  await test('extractYouTubeVideoId recognizes every real YouTube URL shape', () => {
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=5'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  await test('extractYouTubeVideoId returns null for anything not a real YouTube video URL', () => {
    assert.strictEqual(extractYouTubeVideoId('not a url'), null);
    assert.strictEqual(extractYouTubeVideoId(''), null);
    assert.strictEqual(extractYouTubeVideoId(null), null);
    assert.strictEqual(extractYouTubeVideoId(undefined), null);
    assert.strictEqual(extractYouTubeVideoId('https://vimeo.com/12345678'), null);
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/'), null);
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/watch?v=tooshort'), null);
    assert.strictEqual(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  });

  await test('fetchOEmbedMetadata returns real title/author from a successful response', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'A Sample Video Title', author_name: 'Sample Channel' }));
    });
    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${server.address().port}/oembed`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const metadata = await fresh.fetchOEmbedMetadata('dQw4w9WgXcQ');
      assert.deepStrictEqual(metadata, { title: 'A Sample Video Title', authorName: 'Sample Channel' });
    } finally {
      server.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('fetchOEmbedMetadata returns null (never throws) when the video is unavailable', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${server.address().port}/oembed`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const metadata = await fresh.fetchOEmbedMetadata('dQw4w9WgXcQ');
      assert.strictEqual(metadata, null);
    } finally {
      server.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('fetchTranscriptBestEffort extracts real caption text when the watch page has a caption track', async () => {
    let requestedPaths = [];
    const server = await startMockServer((req, res) => {
      requestedPaths.push(req.url);
      if (req.url.startsWith('/watch')) {
        const captionUrl = `http://localhost:${server.address().port}/captions`;
        const html =
          '<html><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":' +
          `{"captionTracks":[{"baseUrl":"${captionUrl}","languageCode":"en"}]}}};</script></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      if (req.url.startsWith('/captions')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<transcript><text start="0" dur="2">Once upon a time,</text><text start="2" dur="2">a story began.</text></transcript>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${server.address().port}/watch`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const transcript = await fresh.fetchTranscriptBestEffort('dQw4w9WgXcQ');
      assert.strictEqual(transcript, 'Once upon a time, a story began.');
    } finally {
      server.close();
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('fetchTranscriptBestEffort returns null (never throws) when the video has no captions', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>no captions here</body></html>');
    });
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${server.address().port}/watch`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const transcript = await fresh.fetchTranscriptBestEffort('dQw4w9WgXcQ');
      assert.strictEqual(transcript, null);
    } finally {
      server.close();
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('fetchTranscriptBestEffort returns null (never throws) when the watch page itself fails to load', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(500);
      res.end('server error');
    });
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${server.address().port}/watch`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const transcript = await fresh.fetchTranscriptBestEffort('dQw4w9WgXcQ');
      assert.strictEqual(transcript, null);
    } finally {
      server.close();
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  // --- analyzeReferenceVideo: the full orchestration, including the one
  // real dependency (a Claude call) via a local mock Anthropic server.

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

  await test('analyzeReferenceVideo refuses — before any call — for a non-YouTube or malformed URL', async () => {
    const result = await analyzeReferenceVideo({ referenceVideoUrl: 'https://vimeo.com/12345678', referenceVideoNotes: '' });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.summary, null);
    assert.ok(result.error.toLowerCase().includes('youtube'));
  });

  await test('analyzeReferenceVideo refuses when there is no video metadata, no captions, and no notes at all', async () => {
    const oembedServer = await startMockServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const watchServer = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${oembedServer.address().port}/oembed`;
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${watchServer.address().port}/watch`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const result = await fresh.analyzeReferenceVideo({
        referenceVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        referenceVideoNotes: '',
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.summary, null);
      assert.ok(result.error.toLowerCase().includes('notes'));
    } finally {
      oembedServer.close();
      watchServer.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('analyzeReferenceVideo succeeds from notes alone, even with no metadata/captions, and never calls Claude when it can\'t gather anything (proven separately above)', async () => {
    const oembedServer = await startMockServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const watchServer = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    let receivedPrompt = null;
    const anthropicServer = await startMockAnthropic((body, res) => {
      receivedPrompt = body && Array.isArray(body.messages) ? body.messages[0].content : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Pacing: brisk. Tone: hopeful. Structure: problem, attempt, resolution.' }],
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
        })
      );
    });

    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${oembedServer.address().port}/oembed`;
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${watchServer.address().port}/watch`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicServer.address().port}`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const result = await fresh.analyzeReferenceVideo({
        referenceVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        referenceVideoNotes: 'A short film about a fox who learns patience while waiting out a storm.',
      });

      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.ok(result.summary.includes('Pacing'));
      assert.ok(receivedPrompt.includes('fox who learns patience'), 'the user notes must reach the analysis prompt');
      assert.ok(!receivedPrompt.toLowerCase().includes('never mention the video\'s actual title') , 'sanity: rules text present, not the notes duplicated oddly');
    } finally {
      oembedServer.close();
      watchServer.close();
      anthropicServer.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('analyzeReferenceVideo\'s prompt explicitly forbids reproducing the original video, and includes real metadata/transcript when available', async () => {
    const oembedServer = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'Some Real Title', author_name: 'Some Channel' }));
    });
    const watchServer = await startMockServer((req, res) => {
      const captionUrl = `http://localhost:${watchServer.address().port}/captions`;
      if (req.url.startsWith('/captions')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<transcript><text>Real dialogue here.</text></transcript>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><script>"captionTracks":[{"baseUrl":"${captionUrl}","languageCode":"en"}]</script></html>`);
    });
    let receivedPrompt = null;
    const anthropicServer = await startMockAnthropic((body, res) => {
      receivedPrompt = body.messages[0].content;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'A format summary.' }] }));
    });

    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${oembedServer.address().port}/oembed`;
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${watchServer.address().port}/watch`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicServer.address().port}`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const result = await fresh.analyzeReferenceVideo({
        referenceVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        referenceVideoNotes: '',
      });

      assert.strictEqual(result.status, 'completed', JSON.stringify(result));
      assert.strictEqual(result.summary, 'A format summary.');
      assert.ok(receivedPrompt.includes('Some Real Title'), 'real metadata must reach the prompt');
      assert.ok(receivedPrompt.includes('Real dialogue here.'), 'the scraped transcript must reach the prompt');
      assert.ok(receivedPrompt.includes('Never quote or closely paraphrase exact dialogue'));
      assert.ok(receivedPrompt.includes('Never name or describe any specific character'));
      assert.ok(receivedPrompt.toLowerCase().includes("never mention the video's own title"));
    } finally {
      oembedServer.close();
      watchServer.close();
      anthropicServer.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  await test('analyzeReferenceVideo returns a real failure, never a fabricated summary, when the Claude call itself fails', async () => {
    const oembedServer = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'A Title', author_name: 'A Channel' }));
    });
    const watchServer = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    const anthropicServer = await startMockAnthropic((body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated Anthropic outage' } }));
    });

    process.env.YOUTUBE_OEMBED_BASE_URL = `http://localhost:${oembedServer.address().port}/oembed`;
    process.env.YOUTUBE_WATCH_BASE_URL = `http://localhost:${watchServer.address().port}/watch`;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${anthropicServer.address().port}`;
    delete require.cache[require.resolve('./reference-video')];
    const fresh = require('./reference-video');

    try {
      const result = await fresh.analyzeReferenceVideo({
        referenceVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        referenceVideoNotes: '',
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.summary, null);
      assert.ok(result.error);
    } finally {
      oembedServer.close();
      watchServer.close();
      anthropicServer.close();
      delete process.env.YOUTUBE_OEMBED_BASE_URL;
      delete process.env.YOUTUBE_WATCH_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      delete require.cache[require.resolve('./reference-video')];
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll reference-video tests passed.');
  }
}

main();
