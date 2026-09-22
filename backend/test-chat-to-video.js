// Regression tests for "Chat-to-Video": pasting a complete, already-written
// script (e.g. from ChatGPT) plus production instructions directly into the
// chat box, instead of using the Create Video form (see server.js's
// isScriptPasteRequest/isScriptPaste, PAID_OR_CONFIRM_TOOLS, and
// prompts/system-prompt.md's "Chat-to-Video" section).
//
// Detection is driven ENTIRELY by the frontend's explicit "Paste Script"
// toggle (isScriptPaste in the request body) — never by message length or
// shape. This is what proves the fix for the original bug: a long ordinary
// chat message is never mistaken for a script, and a short script sent
// with the toggle on is recognized just as reliably as a long one.
//
// What this proves:
//   - an ordinary message, however long, is NEVER saved as job.script
//     unless the request explicitly flags it;
//   - a SHORT script sent with the flag IS saved verbatim — short and long
//     scripts are supported the same way, given clear intent;
//   - a long, freshly-pasted+flagged message is saved verbatim to
//     job.script BEFORE Claude is ever called, and the job summary Claude
//     receives THIS SAME turn already reflects it;
//   - even if the model still tries to set a `script` field on
//     updateVideoJob during a paste turn, it is discarded;
//   - every paid tool AND confirmVideoJob are hard-blocked on the SAME
//     turn as a detected paste — the plan must always be shown and
//     confirmed in a separate, later message first;
//   - re-pasting the exact same script on an already-confirmed job is a
//     no-op (confirmed stays true); pasting a genuinely different script
//     resets confirmed to false so the new plan needs fresh confirmation;
//   - a continuation request never triggers this at all.
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

// A realistic long "pasted from ChatGPT" script + instructions block.
const LONG_PASTED_SCRIPT = [
  "Title: The Lighthouse Keeper's Last Night",
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
    'Arlo knew, with a quiet certainty, that this would be his last watch.',
].join('\n');

// A realistic LONG but ORDINARY chat message — the exact shape of bug this
// fix targets: long, but not a script, and never sent with the toggle on.
const LONG_ORDINARY_MESSAGE =
  "I'm not totally sure yet what topic I want — I was thinking maybe something about " +
  'a small coffee shop, or maybe a documentary-style piece about a local river cleanup ' +
  'project, but I keep going back and forth. Could you ask me a few questions to help ' +
  'me narrow it down? I want something under five minutes, in English, probably with a ' +
  'calm, warm tone rather than anything dramatic. I am also curious whether background ' +
  'music is something you can add automatically or whether I need to provide my own ' +
  'track for that, and how long the whole process usually takes from start to finish.';

assert.ok(LONG_ORDINARY_MESSAGE.length > 400, 'fixture must be long enough to have tripped the old length heuristic');

const SHORT_SCRIPT = 'A tiny frog named Pip hopped across three lily pads and made a brand new friend.';
assert.ok(SHORT_SCRIPT.length < 200, 'fixture must be short enough to have failed the old length heuristic');

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
  const { isScriptPasteRequest, PAID_OR_CONFIRM_TOOLS } = server;

  test('isScriptPasteRequest requires the explicit flag — length/shape alone is never enough', () => {
    assert.strictEqual(
      isScriptPasteRequest({ message: LONG_ORDINARY_MESSAGE, isScriptPaste: false, continueAutomatically: false }),
      false
    );
    assert.strictEqual(
      isScriptPasteRequest({ message: LONG_PASTED_SCRIPT, isScriptPaste: undefined, continueAutomatically: false }),
      false
    );
  });

  test('isScriptPasteRequest accepts a short OR long message once explicitly flagged', () => {
    assert.strictEqual(
      isScriptPasteRequest({ message: SHORT_SCRIPT, isScriptPaste: true, continueAutomatically: false }),
      true
    );
    assert.strictEqual(
      isScriptPasteRequest({ message: LONG_PASTED_SCRIPT, isScriptPaste: true, continueAutomatically: false }),
      true
    );
  });

  test('isScriptPasteRequest never fires on a continuation request, even if flagged', () => {
    assert.strictEqual(
      isScriptPasteRequest({ message: LONG_PASTED_SCRIPT, isScriptPaste: true, continueAutomatically: true }),
      false
    );
  });

  test('PAID_OR_CONFIRM_TOOLS covers every paid tool plus confirmVideoJob, and nothing else', () => {
    assert.deepStrictEqual(
      [...PAID_OR_CONFIRM_TOOLS].sort(),
      [
        'confirmVideoJob',
        'generateSceneImages',
        'generateSceneVideo',
        'generateSubtitles',
        'generateVoiceover',
        'generateYoutubePackage',
      ].sort()
    );
  });

  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  await test('a long ORDINARY chat message without the flag is never saved as job.script (the core bug fix)', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [{ text: 'Sure — a coffee shop story or a river cleanup documentary both work well. Which one appeals to you more?' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: LONG_ORDINARY_MESSAGE, conversationHistory: [], jobId: job.id }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, '', 'a long ordinary message must never be mistaken for a script');
  });

  await test('a SHORT script sent with the flag is saved verbatim — short scripts are supported, not just long ones', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [{ text: 'Got it — a short story about a frog named Pip. What duration and language would you like?' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: SHORT_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, SHORT_SCRIPT);
  });

  await test('a long pasted+flagged script is saved verbatim BEFORE Claude is called, and other fields are extracted', async () => {
    const job = await jobStore.createJob();
    capturedRequests.length = 0;
    claudeTurns = [
      {
        text: "Here's what I extracted: topic \"The Lighthouse Keeper's Last Night\", 3 minutes, English, " +
          'simple-story mode, navy background, slightly slower voice, burned-in subtitles. Voice-over ' +
          'generation and subtitle transcription are real, paid OpenAI calls — shall I go ahead?',
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
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));

    const firstRequestSystemText = capturedRequests[0].system[1].text;
    const summaryJson = JSON.parse(firstRequestSystemText.slice(firstRequestSystemText.indexOf('{')));
    assert.strictEqual(
      summaryJson.script,
      LONG_PASTED_SCRIPT,
      'expected the very first request to Claude to already reflect the saved script'
    );

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, LONG_PASTED_SCRIPT);
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
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, LONG_PASTED_SCRIPT, 'the original pasted script must survive even a conflicting tool call');
    assert.strictEqual(persisted.duration, '3 minutes', 'other fields in the same tool call must still apply normally');
  });

  await test('every paid tool is hard-blocked on the same turn as a pasted script — never actually executes', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { voiceStyle: 'alloy' });
    claudeTurns = [
      {
        text: "Here's the plan — generating the voice-over now.",
        tools: [{ id: 't1', name: 'generateVoiceover', input: {} }],
      },
      { text: 'Let me know when you want to proceed.' },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.autoContinue, false, 'a blocked paid tool must never be deferred/continued either');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.voiceover.status, 'pending', 'generateVoiceover must never actually run on a paste turn');
  });

  await test('confirmVideoJob is hard-blocked on the same turn as a pasted script', async () => {
    const job = await jobStore.createJob();
    claudeTurns = [
      { text: 'Confirming now.', tools: [{ id: 't1', name: 'confirmVideoJob', input: {} }] },
      { text: 'Understood, let me know when ready.' },
    ];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.confirmed, false, 'confirmVideoJob must never actually run on a paste turn');
  });

  await test('re-pasting the exact same script on an already-confirmed job is a no-op — confirmed stays true', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: LONG_PASTED_SCRIPT, confirmed: true });
    claudeTurns = [{ text: 'No changes detected.' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.confirmed, true, 'the exact same script must never un-confirm the job');
  });

  await test('pasting a genuinely DIFFERENT script on an already-confirmed job resets confirmed to false', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: 'The original, already-confirmed script.', confirmed: true });
    claudeTurns = [{ text: "Here's the updated plan for your new script." }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: LONG_PASTED_SCRIPT, conversationHistory: [], jobId: job.id, isScriptPaste: true }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, LONG_PASTED_SCRIPT);
    assert.strictEqual(persisted.confirmed, false, 'a genuinely different pasted script must require fresh confirmation');
  });

  await test('a continuation request (no message) never triggers paste-detection even with the flag set', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, { script: 'The pre-existing script that must remain untouched.' });
    claudeTurns = [{ text: 'Continuing.' }];
    claudeCallIndex = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationHistory: [{ role: 'user', content: 'placeholder' }],
        jobId: job.id,
        continueAutomatically: true,
        isScriptPaste: true,
      }),
    });
    assert.strictEqual(res.status, 200);

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.script, 'The pre-existing script that must remain untouched.');
  });

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
