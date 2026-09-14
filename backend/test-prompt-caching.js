// Regression test for Anthropic prompt caching on the /api/agent request
// (see buildCachedSystemPrompt in server.js). Verifies the exact shape of
// the `system` param this project sends to Claude:
//   - the stable prefix (SYSTEM_PROMPT_BASE — this project's instructions,
//     which the API renders together with TOOLS since tools render first)
//     carries the cache_control breakpoint and is byte-identical regardless
//     of job content;
//   - the per-job summary (topic, script, status, generated content, etc.)
//     is a separate, unmarked block that changes with the job, so it can
//     never be cached.
//
// Makes ZERO real Anthropic API calls — server.js constructs its Anthropic
// client at module load time (requiring an API key to exist), so a
// harmless placeholder key is set below, same as the other tests that
// require('./server') without wanting a live call. This test only inspects
// the request payload this project WOULD send; it cannot verify an actual
// cache hit (usage.cache_read_input_tokens), since that requires a real,
// billed messages.create call this project's testing rules disallow.
// Run with:
//   node test-prompt-caching.js
// or:
//   npm run test:prompt-caching

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const assert = require('assert');

const server = require('./server');
const { buildCachedSystemPrompt, SYSTEM_PROMPT_BASE, TOOLS } = server;

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

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

test('the per-job block reflects THIS job\'s real, current content and differs between jobs', () => {
  const [, jobBlockA] = buildCachedSystemPrompt(jobA);
  const [, jobBlockB] = buildCachedSystemPrompt(jobB);
  assert.ok(jobBlockA.text.includes(jobA.topic), 'expected job A\'s own topic in its summary block');
  assert.ok(jobBlockB.text.includes(jobB.topic), 'expected job B\'s own topic in its summary block');
  assert.notStrictEqual(jobBlockA.text, jobBlockB.text, 'different jobs must produce different summary text');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll prompt-caching tests passed.');
}
