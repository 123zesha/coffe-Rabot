// Regression test for Anthropic prompt caching on the /api/agent request
// (see buildCachedSystemPrompt in server.js). Verifies:
//   - the stable prefix (SYSTEM_PROMPT_BASE — this project's instructions,
//     which the API renders together with TOOLS since tools render first)
//     carries the cache_control breakpoint and is byte-identical regardless
//     of job content;
//   - the per-job summary (topic, script, status, generated content, etc.)
//     is a separate, unmarked block that changes with the job, so it can
//     never be cached;
//   - both real outgoing /api/agent requests (the initial call and the
//     tool-loop follow-up) carry a top-level cache_control field, so the
//     growing conversationHistory the frontend resends benefits from
//     caching too, not just the static system+tools prefix.
//
// Makes ZERO real Anthropic API calls — a local mock HTTP server stands in
// for the Anthropic API (same pattern as test-agent-multi-step-flow.js),
// and ANTHROPIC_BASE_URL points at it before server.js's Anthropic client
// is constructed. This test only inspects the request payloads this
// project actually sends; it cannot verify a real cache hit
// (usage.cache_read_input_tokens), since that requires a real, billed
// messages.create call this project's testing rules disallow.
// Run with:
//   node test-prompt-caching.js
// or:
//   npm run test:prompt-caching

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

async function main() {
  const capturedRequests = [];
  const claudeServer = await startMockServer(async (req, res) => {
    const body = await readJsonBody(req);
    capturedRequests.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // First call replies with a tool_use so a second (follow-up) call in
    // the same request is also exercised; the follow-up replies plain text.
    if (capturedRequests.length === 1) {
      res.end(
        JSON.stringify({
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Noting that down.' },
            { type: 'tool_use', id: 't1', name: 'updateVideoJob', input: { topic: 'A quiet lighthouse' } },
          ],
          stop_reason: 'tool_use',
        })
      );
    } else {
      res.end(JSON.stringify({ id: 'msg_2', content: [{ type: 'text', text: 'Got it.' }], stop_reason: 'end_turn' }));
    }
  });

  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${claudeServer.address().port}`;

  const server = require('./server');
  const jobStore = require('./job-store');
  const { buildCachedSystemPrompt, SYSTEM_PROMPT_BASE, TOOLS } = server;

  const jobA = { id: 'job-a', topic: 'A cooking tutorial', status: 'SCRIPTING', script: 'Script A content.' };
  const jobB = {
    id: 'job-b',
    topic: 'A totally different travel vlog',
    status: 'READY',
    script: 'Completely different script B content.',
    confirmed: true,
  };

  test('SYSTEM_PROMPT_BASE and TOOLS are present and non-trivial', () => {
    assert.strictEqual(typeof SYSTEM_PROMPT_BASE, 'string');
    // Rough proxy for "above the smallest documented cacheable-prefix
    // minimum (512 tokens on Claude Opus 5)" — real token count would
    // require a billed count_tokens/messages.create call, which this
    // project's testing rules disallow making automatically.
    assert.ok(
      SYSTEM_PROMPT_BASE.length > 3000,
      `expected SYSTEM_PROMPT_BASE to be well over the cacheable minimum, got ${SYSTEM_PROMPT_BASE.length} chars`
    );
    assert.ok(Array.isArray(TOOLS) && TOOLS.length > 0, 'expected a non-empty TOOLS array');
  });

  test('no tool definition carries its own cache_control (the system-block breakpoint covers tools too)', () => {
    for (const tool of TOOLS) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(tool, 'cache_control'),
        false,
        `tool "${tool.name}" should not need its own cache_control breakpoint`
      );
    }
  });

  test('buildCachedSystemPrompt returns exactly two blocks: cached prefix + uncached per-job summary', () => {
    const blocks = buildCachedSystemPrompt(jobA);
    assert.ok(Array.isArray(blocks) && blocks.length === 2, 'expected exactly 2 system content blocks');
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[1].type, 'text');
  });

  test('the first block is exactly SYSTEM_PROMPT_BASE and carries the ephemeral cache_control breakpoint', () => {
    const [prefixBlock] = buildCachedSystemPrompt(jobA);
    assert.strictEqual(prefixBlock.text, SYSTEM_PROMPT_BASE, 'first block text must equal SYSTEM_PROMPT_BASE exactly');
    assert.deepStrictEqual(prefixBlock.cache_control, { type: 'ephemeral' });
  });

  test('the second block (per-job summary) never carries a cache_control marker', () => {
    const [, jobBlock] = buildCachedSystemPrompt(jobA);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(jobBlock, 'cache_control'),
      false,
      'the per-job summary block must stay outside the cached prefix'
    );
  });

  test('the cached prefix is byte-identical across two completely different jobs', () => {
    const [prefixA] = buildCachedSystemPrompt(jobA);
    const [prefixB] = buildCachedSystemPrompt(jobB);
    assert.strictEqual(
      prefixA.text,
      prefixB.text,
      'the cached block must never vary with job content — any per-job data leaking in here would silently break caching'
    );
  });

  test("the per-job block reflects THIS job's real, current content and differs between jobs", () => {
    const [, jobBlockA] = buildCachedSystemPrompt(jobA);
    const [, jobBlockB] = buildCachedSystemPrompt(jobB);
    assert.ok(jobBlockA.text.includes(jobA.topic), "expected job A's own topic in its summary block");
    assert.ok(jobBlockB.text.includes(jobB.topic), "expected job B's own topic in its summary block");
    assert.notStrictEqual(jobBlockA.text, jobBlockB.text, 'different jobs must produce different summary text');
  });

  const app = server;
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  await test('the initial /api/agent request carries a top-level cache_control field alongside the explicit system breakpoint', async () => {
    const job = await jobStore.createJob();
    capturedRequests.length = 0;

    const res = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'The topic is a quiet lighthouse.', conversationHistory: [], jobId: job.id }),
    });
    await res.json();

    assert.strictEqual(capturedRequests.length, 2, 'expected the initial call plus one tool-loop follow-up call');
    const [initialRequest, followUpRequest] = capturedRequests;

    for (const [label, request] of [
      ['initial', initialRequest],
      ['follow-up', followUpRequest],
    ]) {
      assert.deepStrictEqual(
        request.cache_control,
        { type: 'ephemeral' },
        `expected a top-level cache_control on the ${label} request so the growing conversationHistory can be cached`
      );
      assert.deepStrictEqual(
        request.system[0].cache_control,
        { type: 'ephemeral' },
        `expected the explicit system-prefix breakpoint to remain intact on the ${label} request`
      );
    }
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
    console.log('\nAll prompt-caching tests passed.');
  }
}

main();
