// Regression tests for "Chat-to-Video": pasting a complete, already-written
// script (e.g. from ChatGPT) plus production instructions directly into the
// chat box, instead of using the Create Video form (see server.js's
// looksLikePastedScript/isScriptPaste and prompts/system-prompt.md's
// "Chat-to-Video" section).
//
// What this proves:
//   - a long, freshly-pasted message is saved verbatim to job.script BEFORE
//     Claude is ever called, so the original wording is preserved exactly
//     and Claude never has to retype it as tool-call output;
//   - the job summary Claude receives THIS SAME turn already reflects the
//     saved script (proves the save happens before the request is built,
//     not after);
//   - even if the model still tries to set a `script` field on
//     updateVideoJob during a paste turn, it is discarded — the original
//     pasted text is never overwritten — while every other field in the
//     same call (duration, language, videoMode) still applies normally;
//   - an ordinary short chat message never triggers this at all;
//   - a job that has already been confirmed never has its script silently
//     replaced by a later long message.
//
// Uses a local mock Anthropic server (no real Claude calls). Run with:
//   node test-chat-to-video.js
// or:
//   npm run test:chat-to-video

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

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

// A realistic "pasted from ChatGPT" script + instructions block — well over
// SCRIPT_PASTE_MIN_LENGTH, mixing real narration with production details
// the Agent should extract rather than ask about again.
const PASTED_SCRIPT = [
  'Title: The Lighthouse Keeper\'s Last Night',
  '',
  'Duration: 3 minutes. Language: English. Background: dark navy blue. ' +
    'Voice speed: 10% slower than normal. Subtitles: burned into the video.',
  '',
  'Once upon a time, on a rocky point where the sea met the sky, there lived an old ' +
    'lighthouse keeper named Arlo. Every night for forty years, he climbed the spiral ' +
    'stairs to light the great lamp, guiding ships safely past the reef that had claimed ' +
    'so many before the tower was built.',
  '',
  'Tonight was different. The storm rolling in was the fiercest he had ever seen, and ' +
    'Arlo knew, with a quiet certainty, that this would be his last watch. He climbed the ' +
    'stairs one final time, his hand tracing the worn groove in the railing left by ' +
    'decades of the same journey, and lit the lamp exactly as he always had.',
  '',
  'As dawn broke and the storm cleared, a young woman arrived at the lighthouse door — ' +
    'his granddaughter, come to learn the keeper\'s trade, exactly as he had once learned ' +
    'it himself. Arlo smiled, handed her the brass key, and knew the light would keep ' +
    'burning long after he was gone.',
].join('\n');

assert.ok(PASTED_SCRIPT.length >= 500, 'test fixture must exceed the paste-detection threshold');

async function main() {
  let claudeTurns = [];
  let claudeCallIndex = 0;
  const capturedRequests = [];
  const claudeServer = await startMockServer(async (req, res) => {
    const body = await readJsonBody(req);
    capturedRequests.push(body);
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

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${claudeServer.address().port}`;

  const server = require('./server');
  const jobStore = require('./job-store');
  const { looksLikePastedScript, SCRIPT_PASTE_MIN_LENGTH } = server;

  test('looksLikePastedScript rejects short/ordinary messages', () => {
    assert.strictEqual(looksLikePastedScript('What voice options do you have?'), false);
    assert.strictEqual(looksLikePastedScript(''), false);
    assert.strictEqual(looksLikePastedScript(undefined), false);
    assert.strictEqual(looksLikePastedScript('x'.repeat(SCRIPT_PASTE_MIN_LENGTH - 1)), false);
  });

  test('looksLikePastedScript accepts a message at/above the threshold', () => {
    assert.strictEqual(looksLikePastedScript('x'.repeat(SCRIPT_PASTE_MIN_LENGTH)), true);
    assert.strictEqual(looksLikePastedScript(PASTED_SCRIPT), true);
  });

  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  await test('an ordinary short chat message never triggers a script paste — job.script stays empty', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [{ text: 'Sure — what topic would you like the video to be about?' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hi, I want to make a video.', conversationHistory: [], jobId: job.id }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, '', 'a short ordinary message must never be saved as the script');
  });

  await test('a pasted script is saved verbatim to job.script BEFORE Claude is called, and the same turn extracts the other details', async () => {
    const job = await jobStore.createJob();
    capturedRequests.length = 0;
    claudeTurns = [
      {
        text: 'Got it — here is the plan: 3-minute English video, simple-story mode, navy background, ' +
          'slower voice, burned-in subtitles. This will use real OpenAI TTS and transcription calls — ' +
          'shall I go ahead?',
        tools: [
          {
            id: 't1',
            name: 'updateVideoJob',
            input: {
              topic: "The Lighthouse Keeper's Last Night",
              duration: '3 minutes',
              language: 'English',
              videoMode: 'simple-story',
              burnInSubtitles: true,
            },
          },
        ],
      },
      { text: 'Understood.' },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: PASTED_SCRIPT, conversationHistory: [], jobId: job.id }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));

    // The FIRST captured request (before Claude replies at all) must already
    // carry the saved script in the per-job summary block — proving the
    // save happened before the request was even built, not as a reaction
    // to anything Claude said.
    const firstRequestSystemText = capturedRequests[0].system[1].text;
    const summaryJson = JSON.parse(firstRequestSystemText.slice(firstRequestSystemText.indexOf('{')));
    assert.strictEqual(
      summaryJson.script,
      PASTED_SCRIPT,
      'expected the very first request to Claude to already reflect the saved script'
    );

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, PASTED_SCRIPT, 'job.script must exactly equal the pasted text');
    assert.strictEqual(persisted.duration, '3 minutes');
    assert.strictEqual(persisted.language, 'English');
    assert.strictEqual(persisted.videoMode, 'simple-story');
    assert.strictEqual(persisted.burnInSubtitles, true);
  });

  await test('a script field on updateVideoJob during a paste turn is discarded — the original pasted text is never overwritten', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [
      {
        text: 'Saved.',
        tools: [
          {
            id: 't1',
            name: 'updateVideoJob',
            // Simulates a model that ignores the "never include script"
            // instruction and tries to retype/paraphrase it anyway.
            input: { script: 'A completely different, model-rewritten script.', duration: '3 minutes' },
          },
        ],
      },
      { text: 'Understood.' },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: PASTED_SCRIPT, conversationHistory: [], jobId: job.id }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, PASTED_SCRIPT, 'the original pasted script must survive even a conflicting tool call');
    assert.strictEqual(persisted.duration, '3 minutes', 'other fields in the same tool call must still apply normally');
  });

  await test('a job that is already confirmed never has its script silently replaced by a later long message', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: 'The original, already-confirmed script.', confirmed: true });
    claudeTurns = [{ text: 'Noted, thanks for the extra detail!' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: PASTED_SCRIPT, conversationHistory: [], jobId: job.id }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, 'The original, already-confirmed script.', 'a confirmed job\'s script must not be silently replaced');
  });

  await test('a continuation request (no message) never triggers paste-detection', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: LONG_ENOUGH_UNRELATED_HISTORY_SCRIPT() });
    claudeTurns = [{ text: 'Continuing.' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationHistory: [{ role: 'user', content: 'placeholder' }],
        jobId: job.id,
        continueAutomatically: true,
      }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, LONG_ENOUGH_UNRELATED_HISTORY_SCRIPT(), 'a continuation request must never touch job.script');
  });

  function LONG_ENOUGH_UNRELATED_HISTORY_SCRIPT() {
    return 'The pre-existing script that must remain untouched by a continuation request.';
  }

  httpServer.close();
  claudeServer.close();

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll Chat-to-Video tests passed.');
  }
}

main();
