// Regression test for the root-cause fix to job-store.js's Redis storage
// shape. The bug: every job the app had ever created was stored together
// under ONE Redis key as a single JSON array, rewritten in full on every
// single create/update/advance. Job records embed real generated media as
// inline base64 data URIs (images[].url, voiceover.url), so that one value
// grew without bound as more jobs/scenes/images were generated — and once
// it (or even one large image within it) approached the hosted Redis REST
// API's per-request payload size limit, the write threw. Because
// EVERYTHING shared one key, that failure was invisible at the point of
// generation (the real OpenAI/Runway call had already succeeded and
// already cost money) and could also block saving completely unrelated
// jobs.
//
// The fix stores each job under its own key (video-job:<id>), with a small
// Set (video-jobs:index) used only to enumerate jobs. This test proves,
// using a fake local HTTP server that speaks the same wire protocol as
// Upstash's REST API (the real @upstash/redis package talks to it — only
// the server is fake), that:
//   1. createJob/getJob/updateJob/listJobs/advanceJob all work correctly
//      against the new per-job-key shape.
//   2. Updating one job's data never reads or writes any other job's key —
//      proving the isolation the fix is actually for.
//   3. A job carrying a huge (simulated) media payload can no longer block
//      an unrelated, small job's save — the exact failure mode the old
//      single-shared-key design was vulnerable to. The old code is not
//      present to run side-by-side, so this is proven by seeding a huge
//      payload directly into the fake store under one job's key and
//      showing an unrelated job's update still succeeds untouched.
//
// No real Redis, OpenAI, or Runway calls are made — only a local HTTP
// server standing in for Upstash's REST API. Run with:
//   node test-job-store-redis-persistence.js
// or:
//   npm run test:job-store-redis-persistence

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

// A minimal stand-in for Upstash's REST API: the real @upstash/redis client
// POSTs a JSON array like ["set", key, value] (object values are already
// JSON-stringified by the SDK before this ever gets sent) and expects back
// { result } on 200, or a non-2xx response with { error } otherwise. Only
// the handful of commands job-store.js actually issues are implemented.
function startMockUpstash({ maxRequestBytes = Infinity } = {}) {
  const store = new Map(); // key -> string value
  const sets = new Map(); // key -> Set<string> (for sadd/smembers)
  const requestLog = []; // { command, key }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      if (rawBody.length > maxRequestBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'max request size exceeded' }));
        return;
      }

      let command;
      try {
        command = JSON.parse(rawBody.toString('utf8'));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid command' }));
        return;
      }

      const [name, ...args] = command;
      requestLog.push({ command: name, key: args[0], bytes: rawBody.length });

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (name === 'set') {
        const [key, value] = args;
        store.set(key, value);
        res.end(JSON.stringify({ result: 'OK' }));
        return;
      }

      if (name === 'get') {
        const [key] = args;
        const value = store.has(key) ? store.get(key) : null;
        res.end(JSON.stringify({ result: value }));
        return;
      }

      if (name === 'sadd') {
        const [key, ...members] = args;
        if (!sets.has(key)) {
          sets.set(key, new Set());
        }
        const set = sets.get(key);
        let added = 0;
        for (const member of members) {
          if (!set.has(String(member))) {
            set.add(String(member));
            added++;
          }
        }
        res.end(JSON.stringify({ result: added }));
        return;
      }

      if (name === 'smembers') {
        const [key] = args;
        const members = sets.has(key) ? [...sets.get(key)] : [];
        res.end(JSON.stringify({ result: members }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `mock does not implement command: ${name}` }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        server,
        url: `http://localhost:${server.address().port}`,
        store,
        sets,
        requestLog,
        seedRawJob(id, job) {
          store.set(`video-job:${id}`, JSON.stringify(job));
          if (!sets.has('video-jobs:index')) {
            sets.set('video-jobs:index', new Set());
          }
          sets.get('video-jobs:index').add(String(id));
        },
      });
    });
  });
}

async function main() {
  const mock = await startMockUpstash();
  process.env.UPSTASH_REDIS_REST_URL = mock.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  // job-store.js reads Redis env vars once, at module load time, to decide
  // whether to construct a Redis client at all — it must be required only
  // after the env vars above are set.
  const jobStore = require('./job-store');

  await test('createJob stores the job under its own key and registers the id in the index — never a shared aggregate key', async () => {
    mock.requestLog.length = 0;
    const job = await jobStore.createJob();

    assert.ok(mock.store.has(`video-job:${job.id}`), 'job must be stored under video-job:<id>');
    assert.ok(mock.sets.get('video-jobs:index')?.has(job.id), 'job id must be registered in the index set');
    assert.ok(!mock.store.has('video-jobs'), 'the old shared aggregate key must never be written');
    assert.ok(
      mock.requestLog.every((entry) => entry.key !== 'video-jobs'),
      'no command may ever target the old shared aggregate key'
    );
  });

  await test('getJob fetches only the requested job\'s own key', async () => {
    const jobA = await jobStore.createJob();
    const jobB = await jobStore.createJob();

    mock.requestLog.length = 0;
    const fetched = await jobStore.getJob(jobA.id);

    assert.strictEqual(fetched.id, jobA.id);
    assert.ok(
      mock.requestLog.every((entry) => entry.key === `video-job:${jobA.id}`),
      `getJob(${jobA.id}) must never touch job ${jobB.id}'s key or any other key`
    );
  });

  await test('updateJob reads and writes only the target job\'s own key', async () => {
    const jobA = await jobStore.createJob();
    const jobB = await jobStore.createJob();

    mock.requestLog.length = 0;
    const updated = await jobStore.updateJob(jobA.id, { topic: 'A new topic for job A' });

    assert.strictEqual(updated.topic, 'A new topic for job A');
    const touchedKeys = new Set(mock.requestLog.map((entry) => entry.key));
    assert.deepStrictEqual([...touchedKeys], [`video-job:${jobA.id}`], `updateJob(${jobA.id}) must never touch job ${jobB.id}'s key`);

    const persistedB = await jobStore.getJob(jobB.id);
    assert.notStrictEqual(persistedB.topic, 'A new topic for job A', "job B's data must be completely unaffected");
  });

  await test('listJobs enumerates every job via the index, not a shared aggregate key', async () => {
    const jobA = await jobStore.createJob();
    const jobB = await jobStore.createJob();

    const all = await jobStore.listJobs();
    const ids = all.map((job) => job.id);

    assert.ok(ids.includes(jobA.id) && ids.includes(jobB.id));
  });

  await test("a job holding a huge (simulated) media payload can no longer block an unrelated job's save", async () => {
    // Seed a job directly with a large fake base64 payload — simulating a
    // real scene image already persisted for a completely different job —
    // without needing a real OpenAI call to produce one.
    const hugeJob = {
      id: 'huge-job',
      images: [{ prompt: 'huge scene', url: `data:image/png;base64,${'A'.repeat(500000)}`, status: 'completed' }],
    };
    mock.seedRawJob('huge-job', hugeJob);

    const smallJob = await jobStore.createJob();

    mock.requestLog.length = 0;
    const updated = await jobStore.updateJob(smallJob.id, { topic: 'still works even with a huge job elsewhere' });

    assert.strictEqual(updated.topic, 'still works even with a huge job elsewhere');
    // The request that actually wrote smallJob's update must be small —
    // nowhere near the huge job's ~500KB payload — proving this job's save
    // never had to transfer the huge job's data.
    const setRequest = mock.requestLog.find((entry) => entry.command === 'set');
    assert.ok(setRequest, 'expected a set command for the update');
    assert.ok(setRequest.bytes < 5000, `expected a small request (~<5KB), got ${setRequest.bytes} bytes`);
  });

  await test('a save that really is too large fails loudly for that one job only, and never touches other jobs', async () => {
    const limited = await startMockUpstash({ maxRequestBytes: 10000 });
    try {
      process.env.UPSTASH_REDIS_REST_URL = limited.url;
      // job-store.js's redis client is already constructed against the
      // first mock server's URL; re-require after resetting the module
      // cache to pick up the new URL for this one test, mirroring a fresh
      // process.
      delete require.cache[require.resolve('./job-store')];
      const scopedJobStore = require('./job-store');

      const jobA = await scopedJobStore.createJob();
      const jobB = await scopedJobStore.createJob();

      // Well under the 10000-byte limit — this update must succeed.
      await scopedJobStore.updateJob(jobA.id, { topic: 'a small, unremarkable update' });

      let threw = false;
      try {
        // Comfortably over the 10000-byte limit — this one must fail.
        await scopedJobStore.updateJob(jobA.id, {
          images: [{ prompt: 'oversized', url: `data:image/png;base64,${'C'.repeat(50000)}`, status: 'completed' }],
        });
      } catch (error) {
        threw = true;
      }
      assert.ok(threw, 'an oversized single-job write must fail loudly, never silently succeed with partial data');

      // Job B, unrelated and small, must be completely unaffected.
      const stillFineB = await scopedJobStore.updateJob(jobB.id, { topic: 'unaffected by job A being oversized' });
      assert.strictEqual(stillFineB.topic, 'unaffected by job A being oversized');
    } finally {
      limited.server.close();
      delete require.cache[require.resolve('./job-store')];
      process.env.UPSTASH_REDIS_REST_URL = mock.url;
    }
  });

  await test('advanceJob still enforces stage-transition rules correctly against the new per-job storage', async () => {
    const job = await jobStore.createJob();
    // NEW -> SCRIPTING has no output requirement (matches existing
    // behavior); jump straight to SCRIPTING to exercise its real gate.
    await jobStore.updateJob(job.id, { status: 'SCRIPTING' });

    const blocked = await jobStore.advanceJob(job.id);
    assert.strictEqual(blocked.error, 'missing_required_output');
    assert.ok(blocked.missingFields.includes('script'));

    await jobStore.updateJob(job.id, {
      script:
        'A short but complete enough script for testing purposes here, well over two hundred ' +
        'characters so it counts as a genuinely complete script for the SCRIPTING stage gate ' +
        'validation used elsewhere in this project, just to be safe and thorough.',
    });

    const advanced = await jobStore.advanceJob(job.id);
    assert.strictEqual(advanced.error, undefined);
    assert.strictEqual(advanced.job.status, 'SCENE PLANNING');

    const persisted = await jobStore.getJob(job.id);
    assert.strictEqual(persisted.status, 'SCENE PLANNING', 'the advanced status must actually be persisted');
  });

  mock.server.close();
  delete require.cache[require.resolve('./job-store')];
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll job-store Redis persistence tests passed.');
  }
}

main();
