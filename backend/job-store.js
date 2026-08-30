// This module stores video production jobs in memory for the lifetime of
// the running process, and mirrors that data to a local JSON file on a
// best-effort basis. It is intended for development/demo purposes only.
// Serverless platforms like Vercel run on a read-only filesystem in
// production, so the file mirror is expected to fail there — that failure
// is caught and ignored, and the in-memory copy keeps working for as long
// as the serverless instance stays warm. Data is not guaranteed to persist
// across requests, cold starts, or deployments. Replace with a real
// database or persistent storage service before relying on this in
// production.

const fs = require('fs');
const path = require('path');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');

let cachedJobs = null;

const STAGES = [
  'NEW',
  'SCRIPTING',
  'SCENE PLANNING',
  'ASSET GENERATION',
  'EDITING',
  'READY',
  'COMPLETED',
];

const JOB_FIELDS = [
  'topic',
  'videoTitle',
  'duration',
  'language',
  'storyStyle',
  'script',
  'scenes',
  'characters',
  'imagePrompts',
  'videoPrompts',
  'voiceover',
  'subtitles',
  'music',
  'thumbnail',
  'description',
  'status',
  'confirmed',
];

function loadJobs() {
  if (cachedJobs !== null) {
    return cachedJobs;
  }

  let raw;

  try {
    raw = fs.readFileSync(JOBS_FILE, 'utf8');
  } catch (error) {
    cachedJobs = [];
    return cachedJobs;
  }

  try {
    const jobs = JSON.parse(raw);
    cachedJobs = Array.isArray(jobs) ? jobs : [];
  } catch (error) {
    console.error('data/jobs.json contains invalid JSON; treating job list as empty.');
    cachedJobs = [];
  }

  return cachedJobs;
}

function saveJobs(jobs) {
  cachedJobs = jobs;

  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + '\n');
  } catch (error) {
    // Read-only filesystem (e.g. Vercel serverless in production) — the
    // in-memory cache above is still updated, so the app keeps working for
    // the lifetime of this instance even though the write didn't persist.
    console.error('Could not write data/jobs.json (read-only filesystem?); continuing in-memory only.');
  }
}

function createDefaultJob(id) {
  return {
    id,
    topic: '',
    videoTitle: '',
    duration: '',
    language: '',
    storyStyle: '',
    script: '',
    scenes: [],
    characters: [],
    imagePrompts: [],
    videoPrompts: [],
    voiceover: '',
    subtitles: '',
    music: '',
    thumbnail: '',
    description: '',
    status: STAGES[0],
    confirmed: false,
  };
}

function listJobs() {
  return loadJobs();
}

function createJob() {
  const jobs = loadJobs();
  const nextId = jobs.reduce((max, job) => Math.max(max, Number(job.id) || 0), 0) + 1;
  const job = createDefaultJob(String(nextId));

  jobs.push(job);
  saveJobs(jobs);

  return job;
}

function getJob(id) {
  return loadJobs().find((job) => job.id === id) || null;
}

function updateJob(id, updates) {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return null;
  }

  for (const field of JOB_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) {
      continue;
    }

    if (field === 'status' && !STAGES.includes(updates.status)) {
      continue;
    }

    job[field] = updates[field];
  }

  saveJobs(jobs);

  return job;
}

const FINAL_STAGE = STAGES[STAGES.length - 1];

function advanceJob(id) {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return { error: 'not_found' };
  }

  const currentIndex = STAGES.indexOf(job.status);

  if (currentIndex === -1 || currentIndex === STAGES.length - 1) {
    return { error: 'no_next_stage', job };
  }

  const nextStage = STAGES[currentIndex + 1];

  if (nextStage === FINAL_STAGE && job.confirmed !== true) {
    return { error: 'confirmation_required', job };
  }

  job.status = nextStage;
  saveJobs(jobs);

  return { job };
}

module.exports = { STAGES, JOB_FIELDS, listJobs, createJob, getJob, updateJob, advanceJob };
