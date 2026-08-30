// This module stores video production jobs as JSON on the local filesystem.
// It is intended for development/demo purposes only. Serverless platforms
// like Vercel do not guarantee persistent file writes in production — the
// filesystem there is ephemeral/read-only per invocation, so data written
// here can be lost between requests or deployments. Replace with a real
// database or persistent storage service before deploying to production.

const fs = require('fs');
const path = require('path');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');

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
  let raw;

  try {
    raw = fs.readFileSync(JOBS_FILE, 'utf8');
  } catch (error) {
    return [];
  }

  try {
    const jobs = JSON.parse(raw);
    return Array.isArray(jobs) ? jobs : [];
  } catch (error) {
    console.error('data/jobs.json contains invalid JSON; treating job list as empty.');
    return [];
  }
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + '\n');
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
