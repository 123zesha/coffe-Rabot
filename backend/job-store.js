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

// Vercel sets VERCEL=1 in every deployed serverless invocation (production
// and preview alike). Those filesystems are read-only, so don't even
// attempt the write there — go straight to in-memory only. Local dev (no
// VERCEL env var) keeps writing to data/jobs.json exactly as before.
const IS_SERVERLESS_PRODUCTION = process.env.VERCEL === '1';

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
  'images',
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

  if (IS_SERVERLESS_PRODUCTION) {
    // Don't attempt to write into the deployed project filesystem at all —
    // it's read-only there. The in-memory cache above is the source of
    // truth for the lifetime of this serverless instance.
    return;
  }

  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + '\n');
  } catch (error) {
    // Defensive fallback for local environments where the write can still
    // fail for other reasons (permissions, missing directory, etc.).
    console.error('Could not write data/jobs.json; continuing in-memory only.');
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
    // Populated by a future image-generation integration, one entry per
    // imagePrompts item it has processed: { prompt, url, status }, where
    // status is 'pending' | 'generating' | 'completed' | 'failed'. Not
    // writable by the conversational agent (see UPDATABLE_JOB_FIELDS in
    // server.js) — only a real generation call should ever populate this.
    images: [],
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

// The output a stage must actually produce before the job can move past it.
// Keyed by the stage the job is CURRENTLY in (i.e. the stage being left).
const STAGE_OUTPUT_REQUIREMENTS = {
  SCRIPTING: ['script'],
  'SCENE PLANNING': ['scenes', 'characters'],
  'ASSET GENERATION': ['imagePrompts', 'videoPrompts'],
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => (typeof item === 'string' ? item.trim().length > 0 : item !== null && item !== undefined))
  );
}

function hasRequiredOutput(job, field) {
  const value = job[field];
  return Array.isArray(value) ? isNonEmptyArray(value) : isNonEmptyString(value);
}

function getMissingOutputs(job) {
  const required = STAGE_OUTPUT_REQUIREMENTS[job.status] || [];
  return required.filter((field) => !hasRequiredOutput(job, field));
}

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

  const missingOutputs = getMissingOutputs(job);

  if (missingOutputs.length > 0) {
    return { error: 'missing_required_output', missingFields: missingOutputs, job };
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
