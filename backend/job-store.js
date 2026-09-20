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
//
// Redis storage shape: each job is stored under its OWN key
// (video-job:<id>), with a small Set (video-jobs:index) of job ids used
// only to enumerate jobs. This is deliberate, not incidental — job records
// embed real generated media as inline base64 data URIs (images.*.url,
// voiceover.url), which can individually run to multiple megabytes. Storing
// every job the app has ever created together under a single key (as an
// earlier version of this module did) means that single value grows
// without bound for the lifetime of the deployment, and EVERY read/write of
// ANY job re-transfers the entire accumulated history of every job's media.
// Hosted Redis REST APIs (Upstash included) enforce a maximum payload size
// per request; once that combined blob — or even one large image within
// it — approaches that limit, the write throws, silently discarding a
// result that was already generated (and already paid for) a moment
// earlier, and — because everything shares one key — can also block
// reading or saving completely unrelated jobs. Per-job keys bound each
// read/write to that one job's own data, so this failure mode cannot arise
// from unrelated jobs, and cannot get steadily worse the more the app has
// been used.

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const JOBS_FILE = path.resolve(__dirname, '..', 'data', 'jobs.json');
const JOB_KEY_PREFIX = 'video-job:';
const JOBS_INDEX_KEY = 'video-jobs:index';

function jobKey(id) {
  return `${JOB_KEY_PREFIX}${id}`;
}

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
  'videoGeneration',
  'finalVideo',
  'simpleStoryRender',
  'referenceVideoUrl',
  'referenceVideoNotes',
  'referenceVideoAnalysis',
  'subtitles',
  'musicEnabled',
  'musicTrack',
  'musicCustomUrl',
  'thumbnail',
  'description',
  'status',
  'confirmed',
  'generateYoutubePackage',
  'youtubePackage',
  'burnInSubtitles',
  'outputFormat',
  'resolutionTier',
  'videoMode',
];

// The only real, supported output-format values — 'horizontal' (16:9),
// 'vertical' (9:16 Shorts), 'square' (1:1) — mirroring
// data/video-options.json's outputOptions orientation values exactly.
// Exported so image-generation.js/video-generation.js/video-assembly.js
// each validate against this same list rather than trusting an arbitrary
// string through to a provider call.
const OUTPUT_FORMATS = ['horizontal', 'vertical', 'square'];
const DEFAULT_OUTPUT_FORMAT = 'horizontal';

// The only real, supported resolution-tier values — mirroring
// data/video-options.json's outputOptions resolution entries (mp4-1080p/
// mp4-4k) exactly. This is a FINAL-ASSEMBLY-ONLY setting: Runway's
// gen4_turbo has no literal 1080p/4K output size, so image generation and
// Runway video generation are untouched by this — they keep generating at
// their existing fixed per-outputFormat canvas regardless of tier (no new
// paid-API cost). Only backend/video-assembly.js's final ffmpeg pass
// upscales to the selected tier's real pixel dimensions. '4k' in
// particular is a real ~3x linear upscale of that same 720p-equivalent
// source footage — the exported FILE genuinely has 4K dimensions, but not
// genuinely 4K-captured detail; this must be told to the user honestly
// (see prompts/system-prompt.md), never implied to be sharper source video.
const RESOLUTION_TIERS = ['720p', '1080p', '4k'];
const DEFAULT_RESOLUTION_TIER = '720p';

// Which final-assembly pipeline a job uses. 'cinematic' (the default,
// preserving every job's exact pre-existing behavior) is the Runway-clip
// pipeline (image-generation.js + video-generation.js + video-assembly.js)
// — real, paid Runway/OpenAI calls per scene. 'simple-story' is the local,
// FFmpeg-only pipeline (see backend/simple-story-video.js) built for
// English learning/listening-practice story videos: no scene images, no
// Runway clips, no paid video-generation call of any kind — the final MP4
// is built directly from the job's own script/voice-over/subtitles. A job
// never mixes the two; see getMissingOutputs below for how 'simple-story'
// skips the image/video-prompt requirement 'cinematic' still has at the
// ASSET GENERATION stage, and server.js's executeTool for the hard guard
// that refuses generateSceneImages/generateSceneVideo (Runway/OpenAI image
// calls) outright on a 'simple-story' job — never just relying on prompt
// discipline for a "no paid Runway calls in this mode" guarantee.
const VIDEO_MODES = ['cinematic', 'simple-story'];
const DEFAULT_VIDEO_MODE = 'cinematic';

// Local (no-Redis) fallback only, from here down to saveJobs — the whole
// job list really is just one small JSON file on disk, so there is no
// per-request payload-size concern to design around locally. The Redis
// path never calls these two functions; see redisGetJob/redisListJobs/
// redisSaveJob/redisCreateJob below.
async function loadJobs() {
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

// --- Redis-backed job access. Each job lives under its own key
// (video-job:<id>); video-jobs:index is a Redis Set of job ids used only to
// enumerate jobs, and is never used to fetch job data directly. Reading or
// writing one job therefore only ever transfers that one job's own data —
// never every job the app has ever created, and never any other job's data.

async function redisGetJob(id) {
  const job = await redis.get(jobKey(id));
  return job || null;
}

async function redisListJobs() {
  const ids = await redis.smembers(JOBS_INDEX_KEY);
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const jobs = await Promise.all(ids.map((id) => redisGetJob(id)));
  return jobs.filter((job) => job !== null);
}

async function redisSaveJob(job) {
  await redis.set(jobKey(job.id), job);
}

async function redisCreateJob() {
  const existingIds = await redis.smembers(JOBS_INDEX_KEY);
  const nextId =
    (Array.isArray(existingIds) ? existingIds : []).reduce((max, id) => Math.max(max, Number(id) || 0), 0) + 1;
  const job = createDefaultJob(String(nextId));

  // Register the id first: if the job write below ever fails, the worst
  // case is a dangling id that redisListJobs already filters out (getJob
  // for that id returns null), never a job whose data exists but is
  // unreachable.
  await redis.sadd(JOBS_INDEX_KEY, job.id);
  await redisSaveJob(job);

  return job;
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
    // processed: { prompt, url, status, outputFormat, error? }, where
    // status is 'completed' | 'failed' and error is only present on
    // failure. url is only set when the API actually returned image data.
    // outputFormat records which of OUTPUT_FORMATS this specific image was
    // actually generated at, so generateImagesForPrompts's own "already
    // completed, skip" reuse check can tell a real format change (job.
    // outputFormat edited after this scene was already generated) from a
    // genuine no-op — an image generated at the wrong format is never
    // silently kept just to save a call. Not writable by the conversational
    // agent (see UPDATABLE_JOB_FIELDS in server.js) — only the real
    // generation call populates this.
    images: [],
    // Which of OUTPUT_FORMATS (above) this job renders at throughout image
    // generation, Runway video generation, and final ffmpeg assembly.
    // Writable by the conversational agent like topic/language/storyStyle —
    // it's a preference, not a generation result. Defaults to 'horizontal'
    // (16:9), preserving the exact pre-existing behavior for any job that
    // never sets this.
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    // Which of RESOLUTION_TIERS (above) the FINAL assembled MP4 is exported
    // at — independent of outputFormat (orientation) and applied only in
    // video-assembly.js's last ffmpeg pass. Writable by the conversational
    // agent like outputFormat. Defaults to '720p', preserving the exact
    // pre-existing pixel dimensions for any job that never sets this.
    resolutionTier: DEFAULT_RESOLUTION_TIER,
    // Which final-assembly pipeline this job uses — see VIDEO_MODES above.
    // Defaults to 'cinematic', preserving the exact pre-existing Runway
    // pipeline for any job that never sets this. Writable by the
    // conversational agent like outputFormat/resolutionTier — a
    // preference, not a generation result.
    videoMode: DEFAULT_VIDEO_MODE,
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
    // Tracks per-scene video clip generation through the provider-
    // independent video generation layer (see backend/video-generation.js
    // and backend/video-providers/runway.js): { provider, status, clips,
    // error }. provider is the video generation provider that handled the
    // request (e.g. 'runway'); status is 'not_started' | 'processing' |
    // 'completed' | 'failed' for the job as a whole ('completed' only once
    // every scene's clip is completed); clips is one entry per scene,
    // { status, externalJobId, url, error, attempts, ratio }, url only ever
    // set once a real playable clip was retrieved. ratio records the exact
    // Runway aspect-ratio string (e.g. '1280:720') this specific clip was
    // actually submitted at, so generateClip's own "already completed,
    // never resubmit" reuse check can tell a real format change (job.
    // outputFormat edited after this scene's clip already completed) from a
    // genuine no-op — a clip generated at the wrong ratio is never silently
    // kept just to save a Runway call. Not writable by the conversational
    // agent — only the real generation route populates this. IMPORTANT:
    // even when every clip is completed, that is many separate short
    // clips, not one final assembled video — turning them into one is the
    // separate assembleFinalVideo step below.
    videoGeneration: { provider: null, status: 'not_started', clips: [], error: null },
    // The real, final, single playable output video: { url, status,
    // error? }, where status is 'pending' | 'completed' | 'failed'. Only
    // ever populated by backend/video-assembly.js's real ffmpeg-based
    // assembly (triggered via the assembleFinalVideo Agent tool or
    // POST /api/jobs/:id/assemble-video), which concatenates every
    // completed scene clip above and muxes in the voice-over audio if one
    // exists. Stays 'pending' until that has actually run and succeeded —
    // this is what keeps the job from being marked COMPLETED (see
    // STAGE_OUTPUT_REQUIREMENTS below) until a real final video exists.
    // UNLIKE images[].url/voiceover.url, this is never an embedded base64
    // data: URI — a multi-scene final video is far larger than one image or
    // voice-over track, so backend/video-storage.js stores the real bytes
    // outside the job record (Vercel Blob in production, a local file in
    // dev) and only that lightweight reference URL lives here, keeping this
    // job record small regardless of video size (see video-storage.js's own
    // comment). Not writable by the conversational agent, same as
    // images/voiceover — nothing may ever fabricate a value here.
    // subtitlesUsed records the exact subtitles.content string (or null)
    // that was actually burned into THIS assembled video, so
    // assembleAndStoreFinalVideo (server.js) can tell whether an existing
    // finalVideo is still accurate — e.g. still reflects the job's current
    // burnInSubtitles setting and current subtitles content — or is stale
    // and must be reassembled. Reassembly itself calls no paid API, so
    // there is no cost reason to ever serve a stale result here.
    // musicUsed records a snapshot of the music settings ({ enabled, track,
    // customUrl }, or null when music was off) that were actually mixed
    // into THIS assembled video — same "is the cached result still
    // accurate" role as subtitlesUsed, for the musicEnabled/musicTrack/
    // musicCustomUrl fields below.
    // resolutionUsed records which RESOLUTION_TIERS value THIS assembled
    // video's real pixel dimensions actually reflect — same role again, for
    // the resolutionTier field above.
    // videoModeUsed records which VIDEO_MODES value actually produced THIS
    // assembled video — same "is the cached result still accurate" role,
    // for the videoMode field above. A job whose videoMode is switched
    // between 'cinematic' and 'simple-story' after a final video already
    // exists must never keep serving the old pipeline's stale output.
    // status is 'pending' | 'processing' | 'completed' | 'failed'.
    // 'processing' is Simple Story Video mode only (see simpleStoryRender
    // below) — a real render still under way across more than one
    // assembleFinalVideo call, never a single blocking call for a long
    // story. The cinematic (Runway) pipeline never produces 'processing':
    // its own assembly reliably finishes within one call.
    finalVideo: {
      url: null,
      status: 'pending',
      subtitlesUsed: null,
      musicUsed: null,
      resolutionUsed: null,
      videoModeUsed: null,
    },
    // Durable, resumable progress for Simple Story Video mode's section-by-
    // section rendering (see backend/simple-story-video.js's
    // continueSimpleStoryVideoAssembly) — real production evidence showed a
    // long story's full render (16+ real sections, each a real local ffmpeg
    // encode) can take longer than a single serverless function invocation
    // safely allows, so this lets that work resume across SEPARATE
    // assembleFinalVideo calls instead of needing one request to finish
    // everything. status: 'not_started' | 'in_progress' | 'completed' |
    // 'failed'. sections: one entry per real section this job's current
    // voice-over/subtitles produce — { status: 'pending' | 'completed',
    // url }, url only ever set once that section's real clip was rendered
    // AND durably stored (backend/video-storage.js — Vercel Blob in
    // production, a local file in dev), so completed work already paid for
    // in compute time is never lost between invocations, even if a later
    // section fails or a later invocation is interrupted.
    // audioUrlSnapshot/subtitlesContentSnapshot record exactly which
    // voice-over/subtitles this progress was built from — a fresh
    // voice-over or a real subtitles change invalidates every previously-
    // rendered section (their real narration timing no longer matches), so
    // continueSimpleStoryVideoAssembly discards stale progress and starts
    // over the moment either no longer matches, the same "never serve a
    // stale cached result" discipline finalVideo's own subtitlesUsed/
    // musicUsed/resolutionUsed/videoModeUsed already apply. Not writable by
    // the conversational agent — only the real assembly step populates
    // this, same as images/voiceover/finalVideo.
    simpleStoryRender: {
      status: 'not_started',
      totalSections: null,
      sections: [],
      audioUrlSnapshot: null,
      subtitlesContentSnapshot: null,
      error: null,
    },
    // Optional "Reference Video / Inspiration Mode" input: a YouTube URL the
    // user wants used only as high-level storytelling inspiration (pacing,
    // tone, structure — never its transcript, dialogue, character names, or
    // exact scenes). Both writable by the conversational agent like
    // topic/videoTitle — they're just user-supplied preferences, not
    // generation results. Leaving referenceVideoUrl empty (the default)
    // means this feature is not in use at all; nothing about the rest of
    // the pipeline changes in that case.
    referenceVideoUrl: '',
    // Optional free-text notes (a synopsis, description, or transcript
    // excerpt) the user can paste alongside the URL — see
    // backend/reference-video.js for why a bare URL alone often isn't
    // enough to honestly infer pacing/dialogue-style/scene structure.
    referenceVideoNotes: '',
    // Populated by backend/reference-video.js's real analysis (triggered via
    // the analyzeReferenceVideo Agent tool): { status, summary, error?,
    // analyzedUrl, analyzedNotes }, where status is
    // 'pending' | 'completed' | 'failed'. summary is a real, high-level-only
    // extraction the Agent uses as inspiration when writing an ORIGINAL
    // script — never a transcript, and never something to copy from.
    // analyzedUrl/analyzedNotes record exactly which referenceVideoUrl/
    // referenceVideoNotes this result was produced from, so server.js's
    // analyzeReferenceVideo handler can skip a redundant real Claude call
    // when they're called again unchanged. Not writable by the
    // conversational agent — only the real analysis call populates this,
    // same as images/voiceover.
    referenceVideoAnalysis: { status: 'pending', summary: null, error: null, analyzedUrl: null, analyzedNotes: null },
    // Optional, real subtitles generated from the job's OWN, already-
    // generated voice-over audio (see backend/subtitles-generation.js) —
    // NEVER guessed/estimated from the script's text. { status, format,
    // content, error, generatedFromVoiceoverUrl }, where status is
    // 'pending' | 'completed' | 'failed' and format is always 'srt' for
    // now. content is the real .srt file text, only ever set once OpenAI's
    // transcription of the real audio actually succeeded.
    // generatedFromVoiceoverUrl records exactly which job.voiceover.url
    // this was transcribed from, so server.js's generateSubtitles handler
    // can skip a redundant real transcription call when asked again for
    // the exact same, unchanged audio (the same audio always transcribes
    // to the same correct captions, so this never trades away accuracy —
    // see runGenerateSubtitles's comment in server.js). Not writable by the
    // conversational agent — only the real transcription call populates
    // this, same as voiceover/youtubePackage.
    subtitles: { status: 'pending', format: 'srt', content: null, error: null, generatedFromVoiceoverUrl: null },
    // Optional "burn captions into the final MP4" setting — default OFF.
    // With this false, generateSubtitles/the .srt file still work exactly
    // the same (a real, downloadable/copyable caption file the user can
    // upload to YouTube alongside the video), but assembleFinalVideo never
    // re-encodes captions into the video's own pixels. When true,
    // assembleFinalVideo requires a real, completed subtitles.content to
    // exist first (never invents captions to satisfy this) and burns that
    // exact .srt content into the assembled video via ffmpeg — the .srt
    // file itself stays the single source of truth, so the downloadable
    // file and the burned-in captions can never drift out of sync with
    // each other. Writable by the conversational agent like
    // generateYoutubePackage — it's a preference, not a generation result.
    burnInSubtitles: false,
    // Optional background-music mixing — default OFF (musicEnabled: false),
    // preserving the exact pre-existing silent/video-plus-voiceover-only
    // behavior for any job that never touches this. Writable by the
    // conversational agent like burnInSubtitles/outputFormat — a
    // preference, not a generation result.
    // - musicTrack: the value of one of backend/music-library.js's
    //   getMusicTrackOptions() entries — a track from the user-populated
    //   data/music/ local library (this app never bundles, downloads, or
    //   generates music itself).
    // - musicCustomUrl: an alternative to musicTrack — a one-off track not
    //   in the shared library, given directly as a data: URI or local path
    //   (the same shapes voiceover.url/images[].url already use). Takes
    //   priority over musicTrack when both are set.
    // See backend/music-library.js's resolveJobMusicUrl for exactly how
    // these two combine, and backend/video-assembly.js for the real ffmpeg
    // loop/trim/fade/ducking mix applied when music is actually enabled.
    musicEnabled: false,
    musicTrack: null,
    musicCustomUrl: '',
    thumbnail: '',
    description: '',
    status: STAGES[0],
    confirmed: false,
    // Optional "YouTube Publishing Package" toggle. Default OFF: with this
    // false, nothing in that feature ever runs and no extra paid API call
    // is ever made — the user normally writes their own title/description/
    // thumbnail. Writable by the conversational agent like topic/
    // videoTitle, since it's just a preference, not a generation result. It
    // can be turned on either via the "Create Video" form checkbox or by
    // the user directly asking in chat for a title/description/thumbnail
    // to be created — see prompts/system-prompt.md.
    generateYoutubePackage: false,
    // Populated by the real YouTube-package generation (see
    // backend/youtube-package.js for the text half — titles/description/
    // tags/thumbnail concept — and backend/image-generation.js's
    // generateThumbnailImage for the thumbnail image itself): { status,
    // titles, description, tags, thumbnailConcept, thumbnailText,
    // thumbnailUrl, error, generatedFromScript }, where status is
    // 'pending' | 'completed' | 'failed'. thumbnailUrl is a base64 data URI
    // exactly like images[].url, or null if image generation wasn't
    // configured/failed (the rest of the package can still be 'completed'
    // in that case). generatedFromScript records exactly which job.script
    // this result was generated from, so server.js's generateYoutubePackage
    // handler can skip a redundant real API call when asked again with an
    // unchanged script (mirrors referenceVideoAnalysis's analyzedUrl/
    // analyzedNotes pattern above). Deliberately generated WITHOUT ever
    // reading referenceVideoAnalysis/referenceVideoUrl — see
    // youtube-package.js's own comment for why. Not writable by the
    // conversational agent — only the real generation call populates this,
    // same as images/voiceover/referenceVideoAnalysis.
    youtubePackage: {
      status: 'pending',
      titles: [],
      description: null,
      tags: [],
      thumbnailConcept: null,
      thumbnailText: null,
      thumbnailUrl: null,
      error: null,
      generatedFromScript: null,
    },
  };
}

function applyUpdates(job, updates) {
  for (const field of JOB_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) {
      continue;
    }

    if (field === 'status' && !STAGES.includes(updates.status)) {
      continue;
    }

    job[field] = updates[field];
  }
}

async function listJobs() {
  if (redis) {
    return redisListJobs();
  }
  return loadJobs();
}

async function createJob() {
  if (redis) {
    return redisCreateJob();
  }

  const jobs = await loadJobs();
  const nextId = jobs.reduce((max, job) => Math.max(max, Number(job.id) || 0), 0) + 1;
  const job = createDefaultJob(String(nextId));

  jobs.push(job);
  await saveJobs(jobs);

  return job;
}

async function getJob(id) {
  if (redis) {
    return redisGetJob(id);
  }

  const jobs = await loadJobs();
  return jobs.find((job) => job.id === id) || null;
}

async function updateJob(id, updates) {
  if (redis) {
    const job = await redisGetJob(id);
    if (!job) {
      return null;
    }
    applyUpdates(job, updates);
    await redisSaveJob(job);
    return job;
  }

  const jobs = await loadJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return null;
  }

  applyUpdates(job, updates);
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
  // A job must have a real, successfully rendered final video before it can
  // be marked COMPLETED — confirmation alone is not enough. Per-scene video
  // clips (backend/video-generation.js) are combined into one final MP4 by
  // backend/video-assembly.js's assembleFinalVideo step; until that has
  // actually run and succeeded, finalVideo stays 'pending' and this
  // correctly keeps the job at READY (blocked, not falsely finished).
  READY: ['finalVideo'],
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

  if (field === 'finalVideo') {
    return Boolean(value && typeof value === 'object' && value.status === 'completed' && value.url);
  }

  return isNonEmptyString(value);
}

function getMissingOutputs(job) {
  let required = STAGE_OUTPUT_REQUIREMENTS[job.status] || [];

  // A 'simple-story' job never generates scene images or Runway clips (see
  // VIDEO_MODES above) — imagePrompts/videoPrompts exist only to drive
  // those two paid calls, so requiring them here would block a
  // simple-story job from ever leaving ASSET GENERATION for no real
  // reason. 'cinematic' jobs (the default) are completely unaffected.
  if (job.status === 'ASSET GENERATION' && job.videoMode === 'simple-story') {
    required = required.filter((field) => field !== 'imagePrompts' && field !== 'videoPrompts');
  }

  return required.filter((field) => !hasRequiredOutput(job, field));
}

// Computes the stage transition for `job`, mutating job.status in place
// only on success (no error). Shared by both the Redis and local-file
// paths of advanceJob so the actual persistence call is the only thing
// that differs between them.
function computeAdvance(job) {
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
  return { job };
}

async function advanceJob(id) {
  if (redis) {
    const job = await redisGetJob(id);
    if (!job) {
      return { error: 'not_found' };
    }
    const result = computeAdvance(job);
    if (!result.error) {
      await redisSaveJob(job);
    }
    return result;
  }

  const jobs = await loadJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return { error: 'not_found' };
  }

  const result = computeAdvance(job);
  if (!result.error) {
    await saveJobs(jobs);
  }
  return result;
}

module.exports = {
  STAGES,
  JOB_FIELDS,
  MIN_SCRIPT_LENGTH,
  OUTPUT_FORMATS,
  DEFAULT_OUTPUT_FORMAT,
  RESOLUTION_TIERS,
  DEFAULT_RESOLUTION_TIER,
  VIDEO_MODES,
  DEFAULT_VIDEO_MODE,
  listJobs,
  createJob,
  getJob,
  updateJob,
  advanceJob,
};
