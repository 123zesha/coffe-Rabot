// Regression test for the "false completion" bug: a video job must never
// reach COMPLETED, and advanceJob must never report success, unless a real
// rendered final video actually exists. Run with:
//   node test-completion-gate.js
// or:
//   npm run test:completion-gate
//
// Uses the real job-store module against its local data/jobs.json fallback
// (no Redis needed to run this) and restores that file's original contents
// when done, so it never leaves test data behind.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const originalJobsFile = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : null;

// job-store.js caches job data in module-level memory after its first read,
// so reset the file to an empty list before requiring it, to guarantee a
// clean, deterministic starting point for these tests.
fs.writeFileSync(JOBS_FILE, '[]\n');

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

async function buildConfirmedReadyJob(overrides) {
  const job = await jobStore.createJob();
  await jobStore.updateJob(job.id, {
    script:
      'A short but complete enough script for testing purposes here, well over two hundred ' +
      'characters so it counts as a genuinely complete script for the SCRIPTING stage gate ' +
      'validation used elsewhere in this project, just to be safe and thorough.',
    scenes: ['Scene 1'],
    characters: ['Mira'],
    imagePrompts: ['A scene'],
    videoPrompts: ['A pan shot'],
    status: 'READY',
    confirmed: true,
    ...overrides,
  });
  return job.id;
}

async function main() {
  await test('new jobs never start with a pre-populated or fabricated finalVideo', async () => {
    const job = await jobStore.createJob();
    assert.deepStrictEqual(
      job.finalVideo,
      { url: null, status: 'pending' },
      'new jobs must start with no final video asset'
    );
  });

  await test('a confirmed READY job with no rendered video cannot advance to COMPLETED', async () => {
    const jobId = await buildConfirmedReadyJob();

    const result = await jobStore.advanceJob(jobId);

    assert.strictEqual(
      result.error,
      'missing_required_output',
      'expected advanceJob to block on missing output, not report success'
    );
    assert.ok(
      Array.isArray(result.missingFields) && result.missingFields.includes('finalVideo'),
      'expected finalVideo to be reported as the missing required output'
    );
    assert.strictEqual(result.job.status, 'READY', 'job status returned by advanceJob must still be READY');

    const persisted = await jobStore.getJob(jobId);
    assert.strictEqual(persisted.status, 'READY', 'persisted job must still be READY, not COMPLETED');
  });

  await test('confirmation alone is not sufficient to mark a job COMPLETED', async () => {
    const jobId = await buildConfirmedReadyJob({ confirmed: true });
    const job = await jobStore.getJob(jobId);
    assert.strictEqual(job.confirmed, true, 'sanity check: job is confirmed');

    const result = await jobStore.advanceJob(jobId);

    assert.notStrictEqual(
      result.error,
      undefined,
      'advanceJob must not silently succeed just because the job is confirmed'
    );
    assert.notStrictEqual(
      (result.job || {}).status,
      'COMPLETED',
      'job must never reach COMPLETED without a real rendered final video'
    );
  });

  await test('a failed render does not complete the job either', async () => {
    const jobId = await buildConfirmedReadyJob({
      finalVideo: { url: null, status: 'failed', error: 'render error' },
    });

    const result = await jobStore.advanceJob(jobId);

    assert.strictEqual(result.error, 'missing_required_output');
    assert.ok(result.missingFields.includes('finalVideo'));
    assert.notStrictEqual(result.job.status, 'COMPLETED');
  });

  await test('a real, successfully completed finalVideo is the only thing that allows COMPLETED', async () => {
    // Proves the gate is a real, working check - not something that always
    // blocks unconditionally regardless of the actual field value. This is
    // the one and only way this should ever become possible: an explicit,
    // real write of a completed render result (what a future rendering
    // integration would do), never a guess or a fabricated placeholder.
    const jobId = await buildConfirmedReadyJob({
      finalVideo: { url: 'data:video/mp4;base64,ZmFrZQ==', status: 'completed' },
    });

    const result = await jobStore.advanceJob(jobId);

    assert.strictEqual(result.error, undefined, 'expected advanceJob to succeed once a real render exists');
    assert.strictEqual(result.job.status, 'COMPLETED');
  });

  if (originalJobsFile !== null) {
    fs.writeFileSync(JOBS_FILE, originalJobsFile);
  } else {
    fs.writeFileSync(JOBS_FILE, '[]\n');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll completion-gate tests passed.');
  }
}

main();
