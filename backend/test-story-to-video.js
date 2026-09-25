// Tests for the chat-free "Story to Video" flow — server.js's
// POST /api/jobs/story-to-video, POST /api/jobs/:id/upload-voiceover, and
// POST /api/jobs/:id/approve-and-start. Covers script-input job creation,
// "Upload My Own Voice" (format validation, duration measurement, the
// script/audio sync-mismatch warning, zero TTS cost), the shared
// confirmJobForProduction approval gate (including the max-budget check and
// the upload-must-complete-first guard), continueChatToVideoPipeline's
// waiting_for_upload guard, and job isolation between separate Story-to-
// Video jobs.
//
// Uses only real local ffmpeg-generated audio fixtures — no real OpenAI/
// Anthropic API call, no cost. Run with:
//   node test-story-to-video.js
// or:
//   npm run test:story-to-video

const path = require('path');
const fs = require('fs');
const os = require('os');
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

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || '').toString().slice(-800) || error.message));
      resolve();
    });
  });
}

const SHORT_SCRIPT =
  'Once upon a time there was a small lighthouse on a rocky point. Every night the keeper lit the ' +
  'lamp to guide ships safely past the reef. The story of her quiet, steady work became a legend ' +
  'told for generations in the fishing town below.';

async function main() {
  const simpleStoryVideo = require('./simple-story-video');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-to-video-test-'));

  // A short (~3s) real MP3 — deliberately much shorter than SHORT_SCRIPT
  // would take to narrate, so the sync-mismatch warning is expected to fire.
  const shortAudioPath = path.join(workDir, 'short.mp3');
  await runFfmpeg(simpleStoryVideo.ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=3',
    '-c:a',
    'libmp3lame',
    shortAudioPath,
  ]);
  const shortAudioBuffer = fs.readFileSync(shortAudioPath);

  // A WAV fixture, to prove format handling isn't hardcoded to MP3.
  const wavPath = path.join(workDir, 'clip.wav');
  await runFfmpeg(simpleStoryVideo.ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wavPath]);
  const wavBuffer = fs.readFileSync(wavPath);

  // Make sure no BLOB_READ_WRITE_TOKEN is set, so storage falls back to the
  // local data/generated/ path (see video-storage.js) rather than trying a
  // real network call to Vercel Blob.
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const server = require('./server');
  const jobStore = require('./job-store');
  const { continueChatToVideoPipeline } = server;

  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const baseUrl = `http://localhost:${httpServer.address().port}`;

  // ---------------------------------------------------------------------
  // POST /api/jobs/story-to-video
  // ---------------------------------------------------------------------

  await test('POST /api/jobs/story-to-video requires a non-empty script', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: '   ' }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  await test('POST /api/jobs/story-to-video creates an independent simple-story job defaulting to AI voice, warm background, large text', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.job.script, SHORT_SCRIPT, 'the script must be saved verbatim, never rewritten');
    assert.strictEqual(body.job.videoMode, 'simple-story');
    assert.strictEqual(body.job.chatToVideoAutoPipeline, true);
    assert.strictEqual(body.job.voiceSource, 'ai');
    assert.strictEqual(body.job.confirmed, false, 'must never auto-approve production');
    assert.strictEqual(body.job.generateYoutubePackage, false);
    assert.strictEqual(body.job.videoEditSettings.backgroundPreset, 'warm');
    assert.strictEqual(body.job.videoEditSettings.textSize, 'large');
    assert.strictEqual(body.costEstimate.breakdown.voiceover > 0, true, 'AI voice must show a non-zero estimated TTS cost');
  });

  await test('POST /api/jobs/story-to-video with voiceSource "upload" shows zero voice-over cost and ignores any voiceStyle', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload', voiceStyle: 'warm-storyteller' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.job.voiceSource, 'upload');
    assert.strictEqual(body.job.voiceStyle, '', 'voiceStyle has no meaning for an uploaded recording and must be ignored (left at its default)');
    assert.strictEqual(body.costEstimate.breakdown.voiceover, 0, 'an uploaded voice must show zero TTS cost up front');
  });

  await test('POST /api/jobs/story-to-video honors a valid custom backgroundColor over the warm-preset default', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, backgroundColor: 'ff00ff', textSize: 'xl', showCaptions: false }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.job.videoEditSettings.backgroundPreset, null);
    assert.strictEqual(body.job.videoEditSettings.backgroundColor, 'ff00ff');
    assert.strictEqual(body.job.videoEditSettings.textSize, 'xl');
    assert.strictEqual(body.job.videoEditSettings.showCaptions, false);
  });

  await test('POST /api/jobs/story-to-video accepts separate narration and music volume settings, both defaulting to 0', async () => {
    const defaultRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const defaultBody = await defaultRes.json();
    assert.strictEqual(defaultBody.job.videoEditSettings.voiceVolumeDb, 0);
    assert.strictEqual(defaultBody.job.videoEditSettings.musicVolumeDb, 0);

    const customRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceVolumeDb: 6, musicVolumeDb: -9 }),
    });
    const customBody = await customRes.json();
    assert.strictEqual(customBody.job.videoEditSettings.voiceVolumeDb, 6);
    assert.strictEqual(customBody.job.videoEditSettings.musicVolumeDb, -9);
  });

  await test('POST /api/jobs/story-to-video creates a brand-new, isolated job every time — never reuses another job\'s script', async () => {
    const resA = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Job A script about a fox.' }),
    });
    const jobA = (await resA.json()).job;

    const resB = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Job B script about a hawk.' }),
    });
    const jobB = (await resB.json()).job;

    assert.notStrictEqual(jobA.id, jobB.id);
    assert.strictEqual(jobA.script, 'Job A script about a fox.');
    assert.strictEqual(jobB.script, 'Job B script about a hawk.');
    assert.strictEqual(jobA.voiceover.status, 'pending');
    assert.strictEqual(jobB.voiceover.status, 'pending');
  });

  // ---------------------------------------------------------------------
  // POST /api/jobs/:id/upload-voiceover
  // ---------------------------------------------------------------------

  await test('POST /api/jobs/:id/upload-voiceover 404s for an unknown job', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/no-such-job/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });
    assert.strictEqual(res.status, 404);
  });

  await test('POST /api/jobs/:id/upload-voiceover rejects an unsupported content type', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not audio',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(/Unsupported audio format/.test(body.error));
  });

  await test('POST /api/jobs/:id/upload-voiceover rejects an empty body', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.alloc(0),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /api/jobs/:id/upload-voiceover stores a real MP3, measures its real duration, skips TTS cost, and flags a duration mismatch against the script', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover?filename=my-recording.mp3`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();

    assert.strictEqual(body.job.voiceover.status, 'completed');
    assert.strictEqual(body.job.voiceover.source, 'upload');
    assert.strictEqual(body.job.voiceover.originalFilename, 'my-recording.mp3');
    assert.ok(typeof body.job.voiceover.durationSeconds === 'number' && body.job.voiceover.durationSeconds > 0);
    assert.ok(
      body.job.voiceover.syncWarning && /narrate at an average pace/.test(body.job.voiceover.syncWarning),
      'a 3-second clip against a much-longer script must produce a sync warning'
    );
    assert.strictEqual(body.costEstimate.breakdown.voiceover, 0, 'an uploaded voice-over must never carry a TTS cost');
    assert.strictEqual(body.costEstimate.basis, 'measured-voiceover');
  });

  await test('POST /api/jobs/:id/upload-voiceover accepts a real WAV file too', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Short.', voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.strictEqual(body.job.voiceover.status, 'completed');
    assert.ok(body.job.voiceover.durationSeconds > 0);
  });

  await test('POST /api/jobs/:id/upload-voiceover resets downstream subtitles/final-video state so a re-upload can never reuse stale results', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    // Simulate a job that already has completed downstream state from a
    // previous (now-stale) voice-over, exactly as would exist mid-production.
    await jobStore.updateJob(job.id, {
      subtitles: { status: 'completed', format: 'srt', content: 'stale', error: null, generatedFromVoiceoverUrl: 'old-url' },
      finalVideo: { url: '/generated/old.mp4', status: 'completed', subtitlesUsed: null, musicUsed: null, resolutionUsed: null, videoModeUsed: null, editSettingsUsed: null },
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.job.subtitles.status, 'pending', 'a fresh upload must invalidate stale subtitles');
    assert.strictEqual(body.job.finalVideo.status, 'pending', 'a fresh upload must invalidate a stale final video');
  });

  // ---------------------------------------------------------------------
  // POST /api/jobs/:id/upload-music
  // ---------------------------------------------------------------------

  await test('POST /api/jobs/:id/upload-music 404s for an unknown job', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/no-such-job/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });
    assert.strictEqual(res.status, 404);
  });

  await test('POST /api/jobs/:id/upload-music rejects an unsupported content type', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not audio',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(/Unsupported audio format/.test(body.error));
  });

  await test('POST /api/jobs/:id/upload-music rejects an empty body', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.alloc(0),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /api/jobs/:id/upload-music stores a real MP3, enables music, and clears any prior library track', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;
    // Simulate a job that previously had a library track selected — the
    // upload must take over as the one active music source, never leaving
    // a stale musicTrack alongside the fresh musicCustomUrl.
    await jobStore.updateJob(job.id, { musicEnabled: true, musicTrack: 'some-old-library-track' });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();

    assert.strictEqual(body.job.musicEnabled, true);
    assert.ok(body.job.musicCustomUrl, 'expected a real stored url for the uploaded music');
    assert.strictEqual(body.job.musicTrack, null, 'an uploaded track must clear any previously selected library track');
  });

  await test('POST /api/jobs/:id/upload-music accepts a real WAV file too', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.strictEqual(body.job.musicEnabled, true);
    assert.ok(body.job.musicCustomUrl);
  });

  await test('POST /api/jobs/:id/upload-music rejects a corrupt/unreadable audio file', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('this is not a real mp3 file, just plain bytes that ffmpeg cannot decode as audio'),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(/could not be read as a real audio file/.test(body.error));
  });

  await test('uploading music to one job never affects another job\'s music settings', async () => {
    const createA = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Music isolation job A.' }),
    });
    const jobA = (await createA.json()).job;

    const createB = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Music isolation job B.' }),
    });
    const jobB = (await createB.json()).job;

    await fetch(`${baseUrl}/api/jobs/${jobA.id}/upload-music`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });

    const refreshedA = await jobStore.getJob(jobA.id);
    const refreshedB = await jobStore.getJob(jobB.id);
    assert.strictEqual(refreshedA.musicEnabled, true);
    assert.strictEqual(refreshedB.musicEnabled, false, "job B's music settings must be untouched by job A's upload");
    assert.strictEqual(refreshedB.musicCustomUrl, '');
  });

  // ---------------------------------------------------------------------
  // POST /api/jobs/:id/approve-and-start
  // ---------------------------------------------------------------------

  await test('POST /api/jobs/:id/approve-and-start 404s for an unknown job', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/no-such-job/approve-and-start`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });

  await test('POST /api/jobs/:id/approve-and-start refuses an "Upload My Own Voice" job before the recording has been uploaded', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/approve-and-start`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(/Upload your voice recording/.test(body.error));

    const stillUnconfirmed = await jobStore.getJob(job.id);
    assert.strictEqual(stillUnconfirmed.confirmed, false);
  });

  await test('POST /api/jobs/:id/approve-and-start approves an "Upload My Own Voice" job once the recording is in, snapshotting a zero-TTS, measured-duration estimate', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT, voiceSource: 'upload' }),
    });
    const job = (await createRes.json()).job;

    await fetch(`${baseUrl}/api/jobs/${job.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/approve-and-start`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const approvedJob = await res.json();
    assert.strictEqual(approvedJob.confirmed, true);
    assert.strictEqual(approvedJob.approvedCostEstimate.breakdown.voiceover, 0);
    assert.strictEqual(approvedJob.approvedCostEstimate.basis, 'measured-voiceover');
  });

  await test('POST /api/jobs/:id/approve-and-start approves an AI-voice job immediately (no upload needed), using the script-length estimate', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/approve-and-start`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const approvedJob = await res.json();
    assert.strictEqual(approvedJob.confirmed, true);
    assert.strictEqual(approvedJob.approvedCostEstimate.basis, 'script-length');
    assert.ok(approvedJob.approvedCostEstimate.breakdown.voiceover > 0);
  });

  await test('POST /api/jobs/:id/approve-and-start refuses when the live estimate already exceeds the caller\'s maxBudgetUsd', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/approve-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxBudgetUsd: 0.0000001 }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(/exceeds your maximum budget/.test(body.error));
    assert.ok(body.costEstimate);

    const stillUnconfirmed = await jobStore.getJob(job.id);
    assert.strictEqual(stillUnconfirmed.confirmed, false, 'a refused approval must never confirm the job');
  });

  await test('POST /api/jobs/:id/approve-and-start approves when maxBudgetUsd comfortably covers the live estimate', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SHORT_SCRIPT }),
    });
    const job = (await createRes.json()).job;

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/approve-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxBudgetUsd: 100 }),
    });
    assert.strictEqual(res.status, 200);
    const approvedJob = await res.json();
    assert.strictEqual(approvedJob.confirmed, true);
  });

  // ---------------------------------------------------------------------
  // continueChatToVideoPipeline: waiting_for_upload guard
  // ---------------------------------------------------------------------

  await test('continueChatToVideoPipeline reports waiting_for_upload — never falls back to paid TTS — for a confirmed upload job whose voice-over is not (yet) completed', async () => {
    const job = await jobStore.createJob();
    await jobStore.updateJob(job.id, {
      script: SHORT_SCRIPT,
      videoMode: 'simple-story',
      chatToVideoAutoPipeline: true,
      voiceSource: 'upload',
      confirmed: true,
      // voiceover left at its default { status: 'pending' } — simulates
      // reaching this state despite approve-and-start's own guard (e.g. a
      // stale poll racing a fresh re-upload).
    });

    const result = await continueChatToVideoPipeline(job.id);
    assert.strictEqual(result.status, 'waiting_for_upload');
    assert.strictEqual(result.step, 'voiceover');
  });

  // ---------------------------------------------------------------------
  // Job isolation
  // ---------------------------------------------------------------------

  await test('two Story-to-Video jobs never share script, voice-over, subtitles, or render state', async () => {
    const createA = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Isolation job A: a tale of two rivers.', voiceSource: 'upload' }),
    });
    const jobA = (await createA.json()).job;

    const createB = await fetch(`${baseUrl}/api/jobs/story-to-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'Isolation job B: a tale of two mountains.' }),
    });
    const jobB = (await createB.json()).job;

    // Upload real audio only to job A.
    await fetch(`${baseUrl}/api/jobs/${jobA.id}/upload-voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: shortAudioBuffer,
    });

    const refreshedA = await jobStore.getJob(jobA.id);
    const refreshedB = await jobStore.getJob(jobB.id);

    assert.strictEqual(refreshedA.voiceover.status, 'completed');
    assert.strictEqual(refreshedB.voiceover.status, 'pending', "job B's voice-over must be untouched by job A's upload");
    assert.notStrictEqual(refreshedA.script, refreshedB.script);
    assert.strictEqual(refreshedB.voiceSource, 'ai');
    assert.strictEqual(refreshedA.voiceSource, 'upload');
  });

  httpServer.close();
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
    console.log('\nAll Story-to-Video tests passed.');
  }
}

main();
