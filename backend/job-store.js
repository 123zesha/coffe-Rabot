// This module stores video production jobs. When a Redis database is
// configured (UPSTASH_REDIS_REST_URL/TOKEN, or the equivalent KV_REST_API_*
// names some providers use), that Redis instance is the durable source of
// truth and every job read/write goes through it — this is required for
// correctness on serverless platforms like Vercel, where a function
// invocation can land on any instance and process memory is never shared
// or guaranteed to survive between requests. Without Redis configured, this
// falls back to an in-memory cache mirrored to a local JSON file, exactly as
// before — fine for local development, but on Vercel that fallback loses
// job data (including a completed script) the moment a different instance
// or a cold start handles the next request, since the deployed filesystem
// is read-only and process memory isn't shared. Set the Redis environment
// variables in production to avoid that.

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const JOBS_KEY = 'video-jobs';

// Vercel sets VERCEL=1 in every deployed serverless invocation (production
// and preview alike). Those filesystems are read-only, so don't even
// attempt the local-file write there — go straight to in-memory only (used
// solely as the no-Redis fallback below). Local dev (no VERCEL env var)
// keeps writing to data/jobs.json exactly as before.
const IS_SERVERLESS_PRODUCTION = process.env.VERCEL === '1';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
// enableAutoPipelining is an SDK-level optimization that batches multiple
// commands issued in the same tick into one pipelined HTTP request. This
// store only ever issues one command at a time, so it's disabled to keep
// every request a plain single-command REST call.
const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN, enableAutoPipelining: false })
    : null;

let loggedMissingRedisWarning = false;
let cachedJobs = null; // Only used by the no-Redis fallback path below.

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
  'voiceStyle',
  'voiceover',
  'subtitles',
  'music',
  'thumbnail',
  'description',
  'status',
  'confirmed',
];

async function loadJobs() {
  if (redis) {
    const jobs = await redis.get(JOBS_KEY);
    return Array.isArray(jobs) ? jobs : [];
  }

  if (IS_SERVERLESS_PRODUCTION && !loggedMissingRedisWarning) {
    loggedMissingRedisWarning = true;
    console.error(
      'No Redis configured (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, or ' +
        'KV_REST_API_URL/KV_REST_API_TOKEN): job data is only kept in this ' +
        'instance\'s memory and will be lost — including a completed script — as ' +
        'soon as a different serverless instance or a cold start handles the next ' +
        'request. Provision a Redis database and set those environment variables.'
    );
  }

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

async function saveJobs(jobs) {
  if (redis) {
    await redis.set(JOBS_KEY, jobs);
    return;
  }

  cachedJobs = jobs;

  if (IS_SERVERLESS_PRODUCTION) {
    // Don't attempt to write into the deployed project filesystem at all —
    // it's read-only there. The in-memory cache above is the best available
    // fallback for the lifetime of this serverless instance, but it is not
    // shared across instances — see the warning in loadJobs().
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
    // Populated by the OpenAI image-generation integration (see
    // backend/image-generation.js), one entry per imagePrompts item it has
    // processed: { prompt, url, status, error? }, where status is
    // 'completed' | 'failed' and error is only present on failure. url is
    // only set when the API actually returned image data. Not writable by
    // the conversational agent (see UPDATABLE_JOB_FIELDS in server.js) —
    // only the real generation call populates this.
    images: [],
    // Which named voice-over option (see data/video-options.json ->
    // voiceOverOptions) the user picked; writable by the agent like
    // topic/language/storyStyle, since it's just a preference, not a
    // generation result.
    voiceStyle: '',
    // Populated by the OpenAI voice-over integration (see
    // backend/voiceover-generation.js): { url, status, voice, error? },
    // where status is 'pending' | 'completed' | 'failed' and error is only
    // present on failure. url is only set when the API actually returned
    // audio data. Not writable by the conversational agent — only the real
    // generation call populates this.
    voiceover: { url: null, status: 'pending' },
    subtitles: '',
    music: '',
    thumbnail: '',
    description: '',
    status: STAGES[0],
    confirmed: false,
  };
}

async function listJobs() {
  return loadJobs();
}

async function createJob() {
  const jobs = await loadJobs();
  const nextId = jobs.reduce((max, job) => Math.max(max, Number(job.id) || 0), 0) + 1;
  const job = createDefaultJob(String(nextId));

  jobs.push(job);
  await saveJobs(jobs);

  return job;
}

async function getJob(id) {
  const jobs = await loadJobs();
  return jobs.find((job) => job.id === id) || null;
}

async function updateJob(id, updates) {
  const jobs = await loadJobs();
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

  await saveJobs(jobs);

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

// A truncated script (e.g. a tool call cut off mid-argument) can still be a
// non-empty string, so plain non-emptiness isn't enough to call it
// "complete". Even the shortest offered duration (under 1 minute) narrates
// well over this many characters, so this only rejects obviously-incomplete
// fragments, not legitimately short scripts.
const MIN_SCRIPT_LENGTH = 200;

function hasRequiredOutput(job, field) {
  const value = job[field];

  if (Array.isArray(value)) {
    return isNonEmptyArray(value);
  }

  if (field === 'script') {
    return isNonEmptyString(value) && value.trim().length >= MIN_SCRIPT_LENGTH;
  }

  return isNonEmptyString(value);
}

function getMissingOutputs(job) {
  const required = STAGE_OUTPUT_REQUIREMENTS[job.status] || [];
  return required.filter((field) => !hasRequiredOutput(job, field));
}

async function advanceJob(id) {
  const jobs = await loadJobs();
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
  await saveJobs(jobs);

  return { job };
}

module.exports = { STAGES, JOB_FIELDS, listJobs, createJob, getJob, updateJob, advanceJob };
