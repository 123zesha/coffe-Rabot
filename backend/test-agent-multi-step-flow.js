// Regression tests for the /api/agent "one heavy step per request" guard
// (server.js's HEAVY_TOOLS set) and the resulting continueAutomatically /
// autoContinue resumption protocol.
//
// Why this exists: a real, measured 18-minute voice-over -> subtitles ->
// final-video chain, run entirely inside ONE /api/agent request, took
// ~296-300s against Vercel's 300s function limit — i.e. no safe margin at
// all, even after the voice-over concurrency fix and the ffmpeg assembly
// speedup. The fix defers any SECOND heavy tool call (generateVoiceover,
// generateSubtitles, assembleFinalVideo) attempted within the same
// request, returning autoContinue: true so the frontend can resume the
// exact same conversation as a fresh, separate request — each request
// then only ever does at most one heavy step, safely inside the time
// limit — with no extra prompt from the user.
//
// Uses a local mock Anthropic server (no real Claude calls) and a local
// mock OpenAI server (no real TTS/Whisper calls). The final assembly step
// uses a tiny real local audio/subtitle fixture (not the full 18-minute
// one — that timing is already verified separately) so this test runs
// fast; it exists to prove the ROUTING/orchestration is correct, not to
// re-benchmark ffmpeg. Run with:
//   node test-agent-multi-step-flow.js
// or:
//   npm run test:agent-multi-step-flow

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { execFile } = require('child_process');

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

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        resolve(null);
      }
    });
  });
}

// Trailing spaces would be stripped by findVoiceoverBlocker's own
// job.script.trim().length check, so padding is real extra sentence text,
// not whitespace.
const LONG_ENOUGH_SCRIPT =
  'Once upon a time there was a curious young fox who loved exploring the forest every single morning. ' +
  'She discovered new paths, met new friends, and learned something new every day along the way home. ' +
  'Every evening she returned to her den by the old oak tree, full of stories to tell.';

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || '').toString().slice(-800) || error.message));
      resolve();
    });
  });
}

const FIXTURE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'Once upon a time there was a curious young fox.',
  '',
  '2',
  '00:00:02,000 --> 00:00:04,000',
  'She loved exploring the forest every morning.',
  '',
].join('\n');

async function main() {
  // A real, short, decodable audio fixture — assembleFinalVideo's ffmpeg
  // pipeline needs real audio (to probe duration, mux, etc.), not just
  // placeholder bytes, so the mock TTS server below serves this instead of
  // literal fake bytes (which is fine for tests that only check job state,
  // but not for one that runs the real assembly step).
  const simpleStoryVideo = require('./simple-story-video');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-agent-multi-step-'));
  const fixtureAudioPath = path.join(workDir, 'fixture-voiceover.mp3');
  await runFfmpeg(simpleStoryVideo.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'libmp3lame', fixtureAudioPath]);
  const fixtureAudioBuffer = fs.readFileSync(fixtureAudioPath);

  // --- Mock Claude: scripted per-call-index responses, shared across the
  // whole test file's Claude call count (each `test()` block below resets
  // the script/counter it needs via closures).
  let claudeTurns = [];
  let claudeCallIndex = 0;
  const claudeServer = await startMockServer(async (req, res) => {
    await readJsonBody(req);
    const turn = claudeTurns[claudeCallIndex] || claudeTurns[claudeTurns.length - 1];
    claudeCallIndex++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const content = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });
    for (const toolCall of turn.tools || []) {
      content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input || {} });
    }
    res.end(JSON.stringify({ id: `msg_${claudeCallIndex}`, content, stop_reason: turn.tools ? 'tool_use' : 'end_turn' }));
  });

  // --- Mock OpenAI: TTS + Whisper, both instant (this test is about
  // routing, not about re-verifying TTS/assembly timing).
  const openaiServer = await startMockServer(async (req, res) => {
    await readJsonBody(req);
    if (req.url.includes('/audio/speech')) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(fixtureAudioBuffer);
    } else if (req.url.includes('/audio/transcriptions')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(FIXTURE_SRT);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${claudeServer.address().port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openaiServer.address().port}/v1`;

  const app = require('./server');
  const jobStore = require('./job-store');

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  await test('POST /api/agent still requires "message" for a fresh (non-continuation) request', async () => {
    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory: [] }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('a normal single-tool turn (no chaining) behaves exactly as before, autoContinue is false', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [
      { text: 'Noting that down.', tools: [{ id: 't1', name: 'updateVideoJob', input: { topic: 'A quiet lighthouse' } }] },
      { text: 'Got it — topic saved.' },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'The topic is a quiet lighthouse.', conversationHistory: [], jobId: job.id }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, false);
    assert.strictEqual(body.reply, 'Got it — topic saved.');
    assert.strictEqual(claudeCallIndex, 2, 'a non-heavy tool call must still complete in one request');
  });

  await test('generateVoiceover then generateSubtitles in the same reasoning turn: the second is deferred, not executed', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: LONG_ENOUGH_SCRIPT, videoMode: 'simple-story' });

    claudeTurns = [
      {
        text: "I'll generate the voice-over and subtitles now.",
        tools: [
          { id: 't1', name: 'generateVoiceover', input: {} },
          { id: 't2', name: 'generateSubtitles', input: {} },
        ],
      },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Generate the voice-over and subtitles.', conversationHistory: [], jobId: job.id }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, true, 'a second heavy tool in the same turn must defer, not run inline');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceover.status, 'completed', 'the FIRST heavy tool must still run for real');
    assert.strictEqual(persisted.subtitles.status, 'pending', 'the DEFERRED second heavy tool must never have run');

    // The deferred tool_result must be visible in conversationHistory so
    // Claude can tell the user it is continuing automatically, not failed.
    const lastMessage = body.conversationHistory[body.conversationHistory.length - 1];
    const deferredResult = lastMessage.content.find((block) => block.tool_use_id === 't2');
    assert.ok(deferredResult, 'expected a tool_result for the deferred tool_use id');
    const deferredPayload = JSON.parse(deferredResult.content);
    assert.strictEqual(deferredPayload.deferred, true);
  });

  await test('full chain across separate requests: voice-over -> subtitles -> final video, one heavy step per request', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: LONG_ENOUGH_SCRIPT, videoMode: 'simple-story' });

    // Each heavy step that gets DEFERRED costs two real Claude calls across
    // its lifecycle: one where Claude first decides to call it (and it gets
    // deferred), and one on the follow-up request where Claude naturally
    // retries the same call (this time it actually executes, since it's
    // the first heavy tool of that fresh request) — Claude only sees a
    // "deferred, will run automatically" tool_result, not a completed one,
    // so retrying it is the expected, correct reaction.
    claudeTurns = [
      { text: "I'll generate the voice-over now.", tools: [{ id: 'v1', name: 'generateVoiceover', input: {} }] }, // call 0 (request 1)
      { text: 'Voice-over is ready. Now generating subtitles.', tools: [{ id: 's1', name: 'generateSubtitles', input: {} }] }, // call 1 (request 1) -> deferred
      { text: 'Generating subtitles now.', tools: [{ id: 's2', name: 'generateSubtitles', input: {} }] }, // call 2 (request 2) -> executes for real
      { text: 'Subtitles are ready. Now assembling the final video.', tools: [{ id: 'a1', name: 'assembleFinalVideo', input: {} }] }, // call 3 (request 2) -> deferred
      { text: 'Assembling the final video now.', tools: [{ id: 'a2', name: 'assembleFinalVideo', input: {} }] }, // call 4 (request 3) -> executes for real
      { text: 'Your complete video is ready.' }, // call 5 (request 3) -> done
    ];
    claudeCallIndex = 0;

    // --- Request 1: only generateVoiceover should run.
    let res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Please make the complete video.', conversationHistory: [], jobId: job.id }),
    });
    let body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, true);
    assert.strictEqual(claudeCallIndex, 2, 'request 1: one Claude call to decide + one to react, no more');

    let persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceover.status, 'completed');
    assert.strictEqual(persisted.subtitles.status, 'pending', 'subtitles must not have run yet in request 1');
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'assembly must not have run yet in request 1');

    // --- Request 2 (continuation): only generateSubtitles should run.
    res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory: body.conversationHistory, jobId: job.id, continueAutomatically: true }),
    });
    body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, true);
    assert.strictEqual(claudeCallIndex, 4, 'request 2: one Claude call to retry+execute subtitles, one to react, no more');

    persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.subtitles.status, 'completed');
    assert.strictEqual(persisted.finalVideo.status, 'pending', 'assembly must not have run yet in request 2');

    // --- Request 3 (continuation): assembleFinalVideo runs for real
    // (small local fixture — real ffmpeg, zero paid calls), then Claude's
    // final reply has no further tool_use, so the chain ends here.
    res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory: body.conversationHistory, jobId: job.id, continueAutomatically: true }),
    });
    body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, false, 'the chain must end once no further tool_use is requested');
    assert.strictEqual(body.reply, 'Your complete video is ready.');

    persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.finalVideo.status, 'completed');
    assert.ok(persisted.finalVideo.url, 'expected a real, stored final video URL');
  });

  server.close();
  claudeServer.close();
  openaiServer.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll agent multi-step flow tests passed.');
  }
}

main();
