const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jobStore = require('./job-store');
const imageGeneration = require('./image-generation');
const voiceoverGeneration = require('./voiceover-generation');
const videoGeneration = require('./video-generation');
const videoAssembly = require('./video-assembly');
const videoStorage = require('./video-storage');
const referenceVideo = require('./reference-video');

const app = express();
const PORT = process.env.PORT || 3000;

// TEMPORARY safety cap for live Runway testing: when a /generate-video (or
// generateSceneVideo Agent tool) call does NOT specify a sceneIndex — i.e.
// it would submit every scene in the job at once — the job must have
// EXACTLY this many video prompts/scenes, so a real full-job test can never
// accidentally submit more than a couple of paid Runway requests in one
// call. It never truncates a larger job down to this count — it refuses
// outright, before any provider call is made. This cap does NOT apply when
// sceneIndex is given: selecting one explicit scene already bounds that
// call to exactly one paid request no matter how many scenes the job has,
// so a genuine single-scene job (or any job size) can generate one
// specific scene without needing a fake extra scene just to satisfy this
// cap. Remove this cap once live testing beyond a small, fixed scene count
// is intentionally needed for full-job runs.
const TEMP_GENERATE_VIDEO_SCENE_CAP = 2;

// imagePrompts[i] and videoPrompts[i] are meant to describe the SAME scene
// — generateVideoForScenes (backend/video-generation.js) already assumes
// this positional pairing when it matches a video prompt to its scene
// image. Nothing previously enforced that pairing before either paid call,
// so a job could reach ASSET GENERATION with imagePrompts set (and real,
// paid scene images already generated) while videoPrompts stayed empty —
// discovered only once video generation was attempted, after the image
// spend had already happened. Checking this BEFORE the first paid call
// (image generation) means a missing/mismatched videoPrompts is caught
// before any money is spent, not after — and the returned message is
// actionable enough (which tool, which field, what shape) that the Agent
// can call updateVideoJob and fix it itself, without asking the user to
// manually repair job data.
function findScenePromptMismatch(job) {
  const imageCount = Array.isArray(job.imagePrompts) ? job.imagePrompts.length : 0;
  const videoCount = Array.isArray(job.videoPrompts) ? job.videoPrompts.length : 0;

  if (imageCount === 0) {
    return 'There are no imagePrompts yet. Use updateVideoJob to set imagePrompts first.';
  }

  if (videoCount === 0) {
    return (
      `There are ${imageCount} imagePrompts but 0 videoPrompts. Use updateVideoJob to set ` +
      'videoPrompts with one motion-description entry per imagePrompts entry, in the same scene ' +
      'order, before generating any scene images or video.'
    );
  }

  if (videoCount !== imageCount) {
    return (
      `imagePrompts has ${imageCount} entries but videoPrompts has ${videoCount}. Use ` +
      'updateVideoJob to make videoPrompts match imagePrompts one-to-one (same length, same scene ' +
      'order) before generating any scene images or video.'
    );
  }

  // Both feed a real paid API call downstream as raw text (the image
  // generation prompt, Runway's promptText) with no defensive coercion —
  // a non-string entry here isn't caught until the provider itself rejects
  // it (e.g. Runway's real, paid "promptText: Invalid input: expected
  // string, received object"). updateVideoJob's own schema now requires
  // string items, but this checks the job's actual current data too, so a
  // job left over from before that schema existed is still caught safely.
  const firstNonStringImagePrompt = job.imagePrompts.findIndex((prompt) => typeof prompt !== 'string');
  if (firstNonStringImagePrompt !== -1) {
    return (
      `imagePrompts[${firstNonStringImagePrompt}] is not a plain string. Use updateVideoJob to set ` +
      'every imagePrompts entry as a short text description, not an object.'
    );
  }

  const firstNonStringVideoPrompt = job.videoPrompts.findIndex((prompt) => typeof prompt !== 'string');
  if (firstNonStringVideoPrompt !== -1) {
    return (
      `videoPrompts[${firstNonStringVideoPrompt}] is not a plain string. Use updateVideoJob to set ` +
      'every videoPrompts entry as a short text description, not an object.'
    );
  }

  return null;
}

// job.videoGeneration.clips[i] must actually exist and be 'completed' — with
// a real url — for every scene before assembleFinalVideo (backend/
// video-assembly.js) is called; assembling from a clip that is missing,
// still processing, or failed would either crash ffmpeg or silently produce
// a final video with a scene missing. Checking this up front, by scene
// number, lets the error tell the Agent exactly which scene still needs
// generateSceneVideo, the same actionable style as findScenePromptMismatch.
function findFinalVideoBlocker(job) {
  const expectedCount = Array.isArray(job.videoPrompts) ? job.videoPrompts.length : 0;
  const clips = job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

  if (expectedCount === 0) {
    return 'There are no videoPrompts yet, so there are no scene video clips to assemble. Set up scene video generation first.';
  }

  if (clips.length === 0) {
    return (
      'No scene video clips have been generated yet. Use generateSceneVideo to generate every ' +
      "scene's video clip before assembling the final video."
    );
  }

  if (clips.length !== expectedCount) {
    return (
      `Only ${clips.length} of ${expectedCount} scene video clip(s) exist yet. Use generateSceneVideo ` +
      'to generate the remaining scene(s) before assembling the final video.'
    );
  }

  const incompleteIndex = clips.findIndex((clip) => !clip || clip.status !== 'completed');
  if (incompleteIndex !== -1) {
    const status = clips[incompleteIndex] ? clips[incompleteIndex].status : 'not_started';
    return (
      `Scene ${incompleteIndex + 1}'s video clip is not completed yet (status: ${status}). Use ` +
      'generateSceneVideo to finish every scene before assembling the final video.'
    );
  }

  return null;
}

// Runs the real ffmpeg assembly step (backend/video-assembly.js) and, only
// on success, stores the resulting bytes outside the job record itself
// (backend/video-storage.js) — see that module's comment for why an
// assembled multi-scene video must never be embedded directly in
// job.finalVideo.url the way images/voiceover are. Shared by the
// assembleFinalVideo Agent tool and its REST route so the two never drift.
//
// Before assembling, every clip is passed through
// videoGeneration.ensureClipStored — a real production failure this caught
// live: findFinalVideoBlocker already guarantees every clip's STATUS reads
// 'completed', but a clip completed before permanent clip storage existed
// still pointed at the provider's own temporary output link, which Runway's
// own docs confirm expires within 24-48 hours. Assembly would then fail
// trying to download an already-dead link. ensureClipStored heals that for
// free (a re-fetch of the same completed task, never a new paid
// submission) — see its own comment in video-generation.js — and any
// healed/recovered clip is persisted back onto the job immediately, so this
// self-heals at most once per clip.
async function assembleAndStoreFinalVideo(job, jobId) {
  const originalClips = job.videoGeneration.clips;
  const healedClips = [];
  for (let i = 0; i < originalClips.length; i++) {
    healedClips.push(await videoGeneration.ensureClipStored({ clip: originalClips[i], jobId, sceneIndex: i }));
  }

  if (healedClips.some((clip, i) => clip !== originalClips[i])) {
    await jobStore.updateJob(jobId, { videoGeneration: { ...job.videoGeneration, clips: healedClips } });
  }

  const brokenIndex = healedClips.findIndex((clip) => clip.status !== 'completed');
  if (brokenIndex !== -1) {
    return {
      url: null,
      status: 'failed',
      error:
        `Scene ${brokenIndex + 1}'s video clip could not be verified or recovered before assembly ` +
        `(${healedClips[brokenIndex].error || 'unknown error'}) — regenerate it with generateSceneVideo.`,
    };
  }

  const assembly = await videoAssembly.assembleFinalVideo({
    clips: healedClips,
    voiceover: job.voiceover,
  });

  if (assembly.status !== 'completed') {
    return { url: null, status: 'failed', error: assembly.error || 'Final video assembly failed.' };
  }

  try {
    const url = await videoStorage.storeFinalVideo(assembly.buffer, jobId);
    return { url, status: 'completed', error: null };
  } catch (error) {
    console.error(
      'Final video storage error:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    return {
      url: null,
      status: 'failed',
      error: `The final video was assembled but could not be stored: ${error.message}`,
    };
  }
}

// job.script must be a real, complete script and voiceStyle must not be
// 'none' before any real OpenAI TTS call — checked once here so the
// existing REST route (the Final Review "Generate Voice-over" button) and
// the generateVoiceover Agent tool can never diverge or duplicate this
// logic (mirrors findScenePromptMismatch/findFinalVideoBlocker's role for
// their own pipelines).
function findVoiceoverBlocker(job) {
  if (!job.script || !job.script.trim()) {
    return 'job has no script to generate a voice-over from';
  }

  if (job.script.trim().length < jobStore.MIN_SCRIPT_LENGTH) {
    return (
      `the script is too short to be an approved, complete script (needs at least ` +
      `${jobStore.MIN_SCRIPT_LENGTH} characters) — finish scripting before generating a voice-over`
    );
  }

  if (job.voiceStyle === 'none') {
    return 'this job is set to no voice-over (text only)';
  }

  return null;
}

const client = new Anthropic();

const VIDEO_OPTIONS = fs.readFileSync(
  path.resolve(__dirname, '..', 'data', 'video-options.json'),
  'utf8'
);

// Parsed once for programmatic use (tool schema enums, validation) —
// VIDEO_OPTIONS itself stays the raw string above since getVideoOptions and
// the system prompt embed it verbatim. Single source of truth: the actual
// selectable voice options (data/video-options.json's voiceOverOptions),
// never a separately hardcoded list that could quietly drift out of sync.
const VIDEO_OPTIONS_DATA = JSON.parse(VIDEO_OPTIONS);
// 'none' ("No Voice-Over") is a real choice for voiceStyle itself (set via
// updateVideoJob), but not a valid input to the generateVoiceover tool —
// generating "no voice" makes no sense, so it's excluded from this list.
const VOICE_STYLE_OPTIONS = VIDEO_OPTIONS_DATA.voiceOverOptions
  .map((option) => option.value)
  .filter((value) => value !== 'none');

const SYSTEM_PROMPT_BASE =
  fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8') +
  '\n\n## Available Video Production Options\n' +
  'These are the ONLY video production options you may offer, confirm, or use. ' +
  'Do not invent, assume, or suggest any language, duration, video style, story/video type, ' +
  'voice-over option, visual style, or output option that is not listed below.\n\n' +
  VIDEO_OPTIONS;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble reaching the AI Agent right now. Please try again in a moment.";

const UPDATABLE_JOB_FIELDS = [
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
  'voiceStyle',
  'referenceVideoUrl',
  'referenceVideoNotes',
  'subtitles',
  'music',
  'thumbnail',
  'description',
];

// job.images[].url and job.voiceover.url each hold a full base64-encoded
// media file (real generated images/audio are commonly hundreds of KB to a
// few MB). The agent never needs the actual bytes to write scripts, plan
// scenes, or decide when to advance stages — only whether generation
// succeeded. Embedding raw media in every tool_result and system prompt
// bloats the conversation history the frontend echoes back on every
// subsequent /api/agent request, which is what previously caused it to
// exceed the request body size limit once a job had generated images. The
// real media is untouched in Redis and stays fully available via
// /api/jobs/:id and the dashboard — this only shapes what the
// agent/conversation sees.
function summarizeJobForAgent(job) {
  if (!job) {
    return job;
  }

  const summarized = { ...job };

  if (Array.isArray(job.images)) {
    summarized.images = job.images.map(({ prompt, status, error }) => ({
      prompt,
      status,
      ...(error ? { error } : {}),
    }));
  }

  if (job.voiceover && typeof job.voiceover === 'object') {
    const { status, voice, voiceStyle, error } = job.voiceover;
    summarized.voiceover = {
      status,
      ...(voice ? { voice } : {}),
      ...(voiceStyle ? { voiceStyle } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (job.videoGeneration && typeof job.videoGeneration === 'object') {
    const { provider, status, error, clips } = job.videoGeneration;
    summarized.videoGeneration = {
      provider,
      status,
      ...(error ? { error } : {}),
      ...(Array.isArray(clips)
        ? { clips: clips.map((clip) => ({ status: clip.status, ...(clip.error ? { error: clip.error } : {}) })) }
        : {}),
    };
  }

  if (job.finalVideo && typeof job.finalVideo === 'object') {
    const { status, error } = job.finalVideo;
    summarized.finalVideo = { status, ...(error ? { error } : {}) };
  }

  return summarized;
}

const TOOLS = [
  {
    name: 'getVideoOptions',
    description:
      'Get the available active video production options: languages, durations, video styles, story/video types, voice-over options, visual styles, and output options.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'updateVideoJob',
    description:
      'Update the current video production job with details gathered or changed during the conversation. Only include the fields being set.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        videoTitle: { type: 'string' },
        duration: { type: 'string' },
        language: { type: 'string' },
        storyStyle: { type: 'string' },
        script: { type: 'string' },
        scenes: { type: 'array', items: {} },
        characters: { type: 'array', items: {} },
        // Must be plain strings: both feed a real paid API call downstream
        // as raw text (image-generation.js's prompt, runway.js's
        // promptText) with no defensive coercion — unlike characters/
        // scenes, which are already handled either way. Allowing objects
        // here (the previous `items: {}`) let the Agent set videoPrompts
        // to something Runway's own validation then rejected with
        // "promptText: Invalid input: expected string, received object" —
        // a real, paid, avoidable failure.
        imagePrompts: { type: 'array', items: { type: 'string' } },
        videoPrompts: { type: 'array', items: { type: 'string' } },
        // Constrained to the project's actual voice-over options (plus
        // 'none') so this can never silently drift to an unsupported value
        // that voiceover-generation.js's VOICE_MAP would then just fall
        // back to a default voice for, without telling anyone.
        voiceStyle: { type: 'string', enum: [...VOICE_STYLE_OPTIONS, 'none'] },
        // Optional "Reference Video / Inspiration Mode" — see
        // backend/reference-video.js. Setting referenceVideoUrl alone does
        // NOT trigger analysis; call analyzeReferenceVideo separately once
        // both are set the way the user wants.
        referenceVideoUrl: { type: 'string' },
        referenceVideoNotes: { type: 'string' },
        subtitles: { type: 'string' },
        music: { type: 'string' },
        thumbnail: { type: 'string' },
        description: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'analyzeReferenceVideo',
    description:
      'Analyze the current job\'s referenceVideoUrl (and referenceVideoNotes, if set) to extract ONLY ' +
      'general, high-level storytelling format elements — story type/theme, pacing, approximate ' +
      'duration, approximate number/length of scenes, dialogue vs. narration style, visual/camera ' +
      'style, emotional tone, and moral/lesson structure — for use as inspiration when writing a ' +
      'completely new, original script. This is part of the OPTIONAL "Reference Video / Inspiration ' +
      'Mode" — only call it when the user has actually provided a reference video URL (via ' +
      'updateVideoJob\'s referenceVideoUrl) and wants it used; never call it otherwise, and never call ' +
      'it if referenceVideoUrl is empty. Uses only free, keyless YouTube metadata plus whatever ' +
      'referenceVideoNotes the user provided, plus one Claude call to summarize — no Runway/OpenAI ' +
      'call, no new paid service. Refuses with a clear reason if the URL isn\'t a recognizable YouTube ' +
      'link, or if there is no real information to analyze at all (no metadata, no captions, and no ' +
      'notes) — when that happens, ask the user to paste a short synopsis into referenceVideoNotes ' +
      '(via updateVideoJob) rather than guessing. The result (referenceVideoAnalysis.summary) is ' +
      'ONLY a high-level format description — never treat it as, or repeat, the original video\'s ' +
      'actual transcript, dialogue, character names/designs, exact scenes, title, thumbnail, or music. ' +
      'Once you have it, write an entirely original English script/scenes/characters inspired only by ' +
      'that general format, with different characters, appearances, clothing, locations, dialogue, and ' +
      'scene details — then continue the normal production flow exactly as usual.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'generateSceneImages',
    description:
      'Generate the real scene images for the current video job from its existing imagePrompts and ' +
      'characters, using the same image-generation backend the rest of this app already uses. Before ' +
      'calling this, set BOTH imagePrompts AND videoPrompts via updateVideoJob together — one ' +
      'videoPrompt (a short motion/camera description) per imagePrompt, in the same scene order — ' +
      'even though this tool only generates images. Scene video generation later needs a matching ' +
      'videoPrompt for the same scene, and preparing it only after images already exist wastes a full ' +
      'round trip; this tool refuses to run at all until both are set with matching lengths. Any ' +
      'imagePrompt that already has a completed image is skipped automatically and is never ' +
      'regenerated or charged again. This can take a little while; let the user know generation is in ' +
      'progress. Only tell the user images were generated if this tool reports them as completed — ' +
      'report any failures honestly instead of assuming success.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'advanceVideoJobStage',
    description:
      'Move the current video production job to its next production stage ' +
      '(NEW -> SCRIPTING -> SCENE PLANNING -> ASSET GENERATION -> EDITING -> READY -> COMPLETED). ' +
      'The job cannot advance into COMPLETED unless it has already been confirmed by the user. ' +
      'It also cannot leave SCRIPTING without a complete script (a short fragment is not enough), ' +
      'leave SCENE PLANNING without non-empty scenes and characters, leave ASSET GENERATION ' +
      'without non-empty imagePrompts and videoPrompts, or leave READY without a real, ' +
      'successfully rendered final video file. Once every scene\'s video clip is completed, call ' +
      'assembleFinalVideo first — this reports finalVideo missing if that has not been done yet. ' +
      'When it reports finalVideo missing, tell the user plainly that the final video is not ' +
      'assembled/available yet and their job stays at the READY stage; never say the video has ' +
      'been produced, rendered, or completed until assembleFinalVideo actually reports it completed.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'confirmVideoJob',
    description:
      'Record that the user has given explicit, unambiguous confirmation of the final video ' +
      'production summary. Only call this immediately after the user clearly confirms ' +
      '(e.g. "yes", "confirmed", "approved", "go ahead"). Never call this for ambiguous, ' +
      'partial, or unclear replies.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'generateSceneVideo',
    description:
      'Generate a REAL, PAID Runway video clip for exactly one scene of the current video job, ' +
      'using the same provider-independent video-generation backend the rest of this app already ' +
      'uses. This costs real Runway credits — only call this when the user has explicitly asked, ' +
      'right now, to generate video for a specific scene. Never call this automatically after ' +
      'generating images, and never call it again to retry a scene that already FAILED unless the ' +
      'user explicitly asks again. IMPORTANT exception: if the scene\'s status is "processing" ' +
      '(Runway accepted the request and is still rendering), calling this again is a FREE, SAFE ' +
      'status check, never a new paid submission — the backend only re-submits a scene whose status ' +
      'is not_started or failed, and a processing scene is only polled. Feel free to call this again ' +
      'to check on a processing scene whenever the user asks for an update, without needing to ask ' +
      'their permission first for that specific check. sceneIndex is REQUIRED: it is the zero-based scene number to ' +
      'generate (0 for "Scene 1", 1 for "Scene 2", etc.) — every other scene in the job is left ' +
      'completely untouched and is never submitted to Runway, so calling this with sceneIndex 0 can ' +
      'never trigger Scene 2 or any other scene. Because sceneIndex already limits every call to one ' +
      'scene, this works for a job with ANY number of scenes, including a genuine single-scene job — ' +
      `never split or restructure the user's story into ${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes just ` +
      'to satisfy a scene-count requirement; there is none when sceneIndex is used. (A full-job run ' +
      `that omits sceneIndex — never do this from the conversation — is capped to exactly ` +
      `${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes for controlled live testing; that limit is irrelevant ` +
      'here since sceneIndex is always required.) If this reports that imagePrompts/videoPrompts are ' +
      'missing or mismatched, fix it yourself with updateVideoJob (never ask the user to manually edit ' +
      'job data) and only then try again — that is preparing prerequisite data, not retrying a failed ' +
      'paid call. Only tell the user a clip was generated if this tool reports that scene as completed ' +
      '— report a failure or still-processing result honestly instead of assuming success.',
    input_schema: {
      type: 'object',
      properties: {
        sceneIndex: { type: 'integer', minimum: 0 },
      },
      required: ['sceneIndex'],
      additionalProperties: false,
    },
  },
  {
    name: 'generateVoiceover',
    description:
      'Generate a REAL, PAID OpenAI text-to-speech voice-over narrating the current job\'s script, ' +
      'using the exact same voice-over backend the Final Review "Generate Voice-over" button already ' +
      'uses. This costs real OpenAI credits — only call this when the user has explicitly asked, right ' +
      'now, to generate or regenerate the voice-over. Optionally pass voiceStyle to set (or change) ' +
      'which voice is used before generating in the same call — e.g. the user saying "use Female Warm ' +
      'voice" or "change the voice to Neutral Narrator" should call this with that voiceStyle right ' +
      'away. If the user only wants to change the voice preference WITHOUT generating yet, use ' +
      'updateVideoJob instead and do not call this. Omitting voiceStyle keeps whatever voice is ' +
      'already set. Every call re-generates the voice-over from the current script from scratch — ' +
      'there is no "already done, skip it" behavior here (unlike scene images/video) — so calling this ' +
      'again is exactly how "regenerate the voice-over with a different voice" works, not a wasted ' +
      'duplicate call. Requires a real, complete script and a voice style other than "no voice-over" — ' +
      'refuses first, before any paid call, if either is missing, and tells you exactly what to fix ' +
      '(never ask the user to fix job data manually). If a final video was already assembled, a ' +
      'successful new voice-over resets it so it must be assembled again with assembleFinalVideo before ' +
      'the fresh narration is actually reflected in the final MP4 — tell the user this if it applies. ' +
      'Only tell the user the voice-over was generated if this reports it as completed.',
    input_schema: {
      type: 'object',
      properties: {
        voiceStyle: { type: 'string', enum: VOICE_STYLE_OPTIONS },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembleFinalVideo',
    description:
      'Combine every already-completed scene video clip (plus the existing voice-over audio, if one ' +
      'has been generated) into one real, playable final MP4 for the current job, using local ffmpeg ' +
      'processing only. This calls NO paid API — every clip and the voice-over were already generated ' +
      'and paid for earlier — so, unlike generateSceneVideo/generateSceneImages, you do not need to ' +
      'ask the user for permission before calling this. Requires every scene\'s video clip to already ' +
      'be completed; if any scene is missing or not yet completed, this refuses with a clear reason — ' +
      'generate the missing scene(s) with generateSceneVideo and try again, never ask the user to fix ' +
      'it manually. If there is no voice-over yet, the final video is produced silently (video only), ' +
      'which is expected, not a failure. Calling this again after it already succeeded is a safe no-op ' +
      'that returns the existing final video unchanged. Only tell the user the final video is ready if ' +
      'this reports it as completed — subtitles, background music, thumbnail generation, and YouTube ' +
      'publishing are still not implemented, so never claim any of those happened.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

async function executeTool(name, jobId, input) {
  if (name === 'getVideoOptions') {
    return VIDEO_OPTIONS;
  }

  if (name === 'updateVideoJob') {
    const updates = {};
    for (const field of UPDATABLE_JOB_FIELDS) {
      if (input && Object.prototype.hasOwnProperty.call(input, field)) {
        updates[field] = input[field];
      }
    }
    const job = await jobStore.updateJob(jobId, updates);
    return JSON.stringify(job ? summarizeJobForAgent(job) : { error: 'job not found' });
  }

  if (name === 'analyzeReferenceVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    if (!job.referenceVideoUrl || !job.referenceVideoUrl.trim()) {
      return JSON.stringify({
        error: 'referenceVideoUrl is not set yet. Use updateVideoJob to set it first (only if the user actually provided a reference video URL).',
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return JSON.stringify({
        error:
          'Reference video analysis is not configured on the server right now. Tell the user this is ' +
          'temporarily unavailable — do not say the video was analyzed.',
      });
    }

    try {
      const referenceVideoAnalysis = await referenceVideo.analyzeReferenceVideo({
        referenceVideoUrl: job.referenceVideoUrl,
        referenceVideoNotes: job.referenceVideoNotes,
      });
      const updatedJob = await jobStore.updateJob(jobId, { referenceVideoAnalysis });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error analyzing reference video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Reference video analysis failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'generateSceneImages') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const promptMismatch = findScenePromptMismatch(job);
    if (promptMismatch) {
      return JSON.stringify({ error: promptMismatch });
    }

    if (!process.env.OPENAI_API_KEY) {
      return JSON.stringify({
        error:
          'Image generation is not configured on the server right now. Tell the user image ' +
          'generation is temporarily unavailable — do not say images were generated.',
      });
    }

    try {
      // Reuses the exact same image-generation implementation the REST
      // route already uses (backend/image-generation.js) — no second
      // image-generation system. That function already skips any prompt
      // that has a completed entry in existingImages, so an already-
      // generated scene is never regenerated or charged again.
      const images = await imageGeneration.generateImagesForPrompts({
        imagePrompts: job.imagePrompts,
        characters: job.characters,
        existingImages: job.images,
      });
      const updatedJob = await jobStore.updateJob(jobId, { images });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating images (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Image generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'advanceVideoJobStage') {
    const result = await jobStore.advanceJob(jobId);

    if (result.error === 'not_found') {
      return JSON.stringify({ error: 'job not found' });
    }

    const job = summarizeJobForAgent(result.job);

    if (result.error === 'confirmation_required') {
      return JSON.stringify({
        error:
          'The job cannot be completed until the user has explicitly confirmed the final production summary.',
        job,
      });
    }
    if (result.error === 'missing_required_output') {
      const isRenderingBlock = result.missingFields.includes('finalVideo');
      return JSON.stringify({
        error: isRenderingBlock
          ? 'The job cannot be marked COMPLETED because no real, assembled final video exists yet. ' +
            'Call assembleFinalVideo once every scene\'s video clip is completed — tell the user ' +
            'their video is not produced/rendered yet and the job stays at the READY stage until ' +
            'that succeeds. Do not call updateVideoJob for this; it cannot be filled in manually.'
          : `The job cannot advance out of ${result.job.status} because the following required output is missing or empty: ` +
            `${result.missingFields.join(', ')}. Use updateVideoJob to fill these in first.`,
        missingFields: result.missingFields,
        job,
      });
    }
    if (result.error === 'no_next_stage') {
      return JSON.stringify({ error: 'job has no next stage', job });
    }

    return JSON.stringify(job);
  }

  if (name === 'confirmVideoJob') {
    const job = await jobStore.updateJob(jobId, { confirmed: true });
    return JSON.stringify(job ? summarizeJobForAgent(job) : { error: 'job not found' });
  }

  if (name === 'generateSceneVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const promptMismatch = findScenePromptMismatch(job);
    if (promptMismatch) {
      return JSON.stringify({ error: promptMismatch });
    }

    const sceneIndex = input && input.sceneIndex;

    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= job.videoPrompts.length) {
      return JSON.stringify({
        error:
          `sceneIndex must be an integer between 0 and ${job.videoPrompts.length - 1} for this job. ` +
          'No Runway request was made.',
      });
    }

    // The TEMPORARY safety cap on POST /api/jobs/:id/generate-video (see
    // TEMP_GENERATE_VIDEO_SCENE_CAP above) exists to bound a full-job run
    // (no sceneIndex) to a couple of paid requests at once. It does not
    // apply here: sceneIndex is REQUIRED for this tool (enforced by its
    // input_schema and re-checked above), so every call is already bounded
    // to exactly one paid provider request no matter how many scenes the
    // job has — including a genuine single-scene job.

    if (!Array.isArray(job.images) || job.images.length === 0) {
      return JSON.stringify({
        error: 'job has no generated scene images yet — generate images before generating video',
      });
    }

    const activeProvider = videoGeneration.getProvider();

    if (activeProvider.name === 'runway' && !process.env.RUNWAYML_API_SECRET) {
      return JSON.stringify({
        error:
          'Video generation is not configured on the server right now. Tell the user video ' +
          'generation is temporarily unavailable — do not say a clip was generated.',
      });
    }

    try {
      // Reuses the exact same video-generation implementation the REST
      // route already uses (backend/video-generation.js) — no second
      // video-generation system. sceneIndex restricts this call to exactly
      // one scene; every other scene's existing clip state is carried
      // through untouched (see generateVideoForScenes), so this can never
      // submit any scene other than the one explicitly requested.
      const existingClips =
        job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

      const result = await videoGeneration.generateVideoForScenes({
        videoPrompts: job.videoPrompts,
        images: job.images,
        existingClips,
        sceneIndex,
      });

      const allCompleted = result.clips.length > 0 && result.clips.every((clip) => clip.status === 'completed');
      const anyProcessing = result.clips.some((clip) => clip.status === 'processing');
      const anyFailed = result.clips.some((clip) => clip.status === 'failed');
      const overallStatus = allCompleted
        ? 'completed'
        : anyProcessing
        ? 'processing'
        : anyFailed
        ? 'failed'
        : 'not_started';

      const videoGenerationField = {
        provider: activeProvider.name,
        status: overallStatus,
        clips: result.clips,
        error: overallStatus === 'failed' ? 'One or more scenes failed to generate a video clip.' : null,
      };

      // finalVideo is never set here — many separate scene clips are not
      // one final assembled video (see the /generate-video route and
      // job-store.js's finalVideo comment). The COMPLETED gate is untouched.
      const updatedJob = await jobStore.updateJob(jobId, { videoGeneration: videoGenerationField });

      const sceneClip = result.clips[sceneIndex];
      return JSON.stringify({
        job: updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' },
        requestedScene: sceneIndex,
        // Mirrors summarizeJobForAgent's own clip shape — status/error only,
        // never the clip URL or externalJobId, consistent with how every
        // other generated asset is reported back to the conversation.
        sceneResult: sceneClip
          ? { status: sceneClip.status, ...(sceneClip.error ? { error: sceneClip.error } : {}) }
          : null,
      });
    } catch (error) {
      console.error(
        'Unexpected error generating video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Video generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'generateVoiceover') {
    let job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    // Setting the voice preference and generating are one tool call when
    // the user names a voice (e.g. "use Female Warm voice") — updateJob
    // returns the updated job directly, so every check below (script
    // length, voiceStyle !== 'none') already sees the new voiceStyle.
    if (input && typeof input.voiceStyle === 'string' && input.voiceStyle) {
      job = await jobStore.updateJob(jobId, { voiceStyle: input.voiceStyle });
    }

    const blocker = findVoiceoverBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    if (!process.env.OPENAI_API_KEY) {
      return JSON.stringify({
        error:
          'Voice-over generation is not configured on the server right now. Tell the user voice-over ' +
          'generation is temporarily unavailable — do not say a voice-over was generated.',
      });
    }

    try {
      // Reuses the exact same voice-over implementation the REST route
      // already uses (backend/voiceover-generation.js) — no second
      // voice-over system.
      const voiceover = await voiceoverGeneration.generateVoiceover({
        script: job.script,
        voiceStyle: job.voiceStyle,
      });

      const updates = { voiceover };
      if (voiceover.status === 'completed') {
        // A fresh voice-over invalidates any already-assembled final video
        // — it was combined from whatever narration (or silence) existed
        // before, and no longer reflects this new one. Resetting finalVideo
        // here means assembleFinalVideo's own "already completed, skip"
        // check never keeps serving a stale, out-of-sync video afterward.
        updates.finalVideo = { url: null, status: 'pending' };
      }

      const updatedJob = await jobStore.updateJob(jobId, updates);
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating voice-over (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Voice-over generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'assembleFinalVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    // Already assembled — return the existing result unchanged rather than
    // re-running ffmpeg on every call. Not a paid-cost concern like the
    // image/video providers, but still real, non-trivial local compute, and
    // re-assembling would otherwise silently replace a job's real final
    // video with a fresh one whenever the Agent is asked about it again.
    if (job.finalVideo && job.finalVideo.status === 'completed' && job.finalVideo.url) {
      return JSON.stringify(summarizeJobForAgent(job));
    }

    const blocker = findFinalVideoBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    try {
      // Reuses the exact same assembly + storage implementation the REST
      // route already uses (backend/video-assembly.js, backend/
      // video-storage.js) — no second assembly system. Calls no paid API:
      // every clip and the voice-over were already generated (and, for the
      // clips, already paid for) earlier.
      const finalVideo = await assembleAndStoreFinalVideo(job, jobId);
      const updatedJob = await jobStore.updateJob(jobId, { finalVideo });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error assembling final video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Final video assembly failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// 1mb comfortably covers a real conversation's text (scripts, scene/tool
// history) — realistically tens of KB even for a long one — while still
// catching an oversized payload (e.g. raw image data leaking back into the
// conversation again in the future) with a clear error instead of silently
// accepting multi-MB request bodies.
app.use(express.json({ limit: '1mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON in request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body is too large' });
  }
  next(err);
});
app.use(express.static(path.resolve(__dirname, '..', 'frontend')));
// Serves a locally-assembled final video back out (see
// backend/video-storage.js) — only ever populated in local dev/tests, where
// there is no BLOB_READ_WRITE_TOKEN and the video was written to
// data/generated/ instead of Vercel Blob. In production this directory is
// never written to (Vercel's deployed filesystem is read-only) and this
// route simply serves nothing.
app.use('/generated', express.static(videoStorage.GENERATED_DIR));

app.post('/api/agent', async (req, res) => {
  const { message, conversationHistory, jobId: requestedJobId } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const existingJob = requestedJobId ? await jobStore.getJob(requestedJobId) : null;
  const jobId = existingJob ? existingJob.id : (await jobStore.createJob()).id;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const messages = [...history, { role: 'user', content: message }];

  async function buildSystemPrompt() {
    const currentJob = await jobStore.getJob(jobId);
    return (
      SYSTEM_PROMPT_BASE +
      '\n\n## Current Video Production Job\n' +
      'This is the current state of the video production job for this conversation. ' +
      'Use the updateVideoJob, advanceVideoJobStage, and confirmVideoJob tools to keep it accurate.\n\n' +
      JSON.stringify(summarizeJobForAgent(currentJob))
    );
  }

  try {
    // 16000 (not the previous 1024) so a full video script — or any other
    // large field — can fit inside a single updateVideoJob tool call
    // without hitting the cap mid-argument. A script cut off by max_tokens
    // either saves as a truncated fragment or drops out of the tool call
    // entirely, which is what caused SCRIPTING's stage gate to report the
    // script as missing/incomplete.
    let response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: await buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    let toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');

    // Drive this off the actual presence of tool_use blocks, not stop_reason.
    // If a response hits max_tokens (Opus 5 runs adaptive thinking by
    // default, which eats into the output budget) while a tool_use block
    // is already complete, stop_reason won't be 'tool_use' even though an
    // unresolved tool call is sitting in the content — sending that back
    // to the API without its tool_result next produces a 400
    // invalid_request_error ("tool_use ids were found without tool_result
    // blocks immediately after"). Checking the blocks themselves guarantees
    // every tool_use is always paired before the turn is treated as done.
    while (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tool) => ({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: await executeTool(tool.name, jobId, tool.input),
        }))
      );
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 16000,
        system: await buildSystemPrompt(),
        tools: TOOLS,
        messages,
      });
      toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
    }

    const textBlock = response.content.find((block) => block.type === 'text');

    res.json({
      reply: textBlock ? textBlock.text : '',
      conversationHistory: [...messages, { role: 'assistant', content: response.content }],
      jobId,
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(
        'Claude API error:',
        JSON.stringify(
          {
            name: error.constructor.name,
            status: error.status,
            type: error.type,
            message: error.message,
            error: error.error,
            request_id: error.requestID,
            cause: error.cause instanceof Error ? error.cause.message : error.cause,
          },
          null,
          2
        )
      );
    } else {
      console.error(
        'Unexpected error calling Claude API:',
        JSON.stringify(
          { name: error?.name, message: error?.message, stack: error?.stack },
          null,
          2
        )
      );
    }

    res.json({
      reply: FALLBACK_REPLY,
      conversationHistory: history,
      jobId,
    });
  }
});

app.get('/api/jobs', async (req, res) => {
  res.json(await jobStore.listJobs());
});

app.post('/api/jobs', async (req, res) => {
  const job = await jobStore.createJob();
  res.status(201).json(job);
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.patch('/api/jobs/:id', async (req, res) => {
  const job = await jobStore.updateJob(req.params.id, req.body || {});

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.post('/api/jobs/:id/generate-images', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const promptMismatch = findScenePromptMismatch(job);
  if (promptMismatch) {
    return res.status(400).json({ error: promptMismatch });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const images = await imageGeneration.generateImagesForPrompts({
      imagePrompts: job.imagePrompts,
      characters: job.characters,
      existingImages: job.images,
    });

    const updatedJob = await jobStore.updateJob(job.id, { images });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating images:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Image generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-voiceover', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const blocker = findVoiceoverBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const voiceover = await voiceoverGeneration.generateVoiceover({
      script: job.script,
      voiceStyle: job.voiceStyle,
    });

    const updates = { voiceover };
    if (voiceover.status === 'completed') {
      // See the generateVoiceover Agent tool's identical comment: a fresh
      // voice-over invalidates any already-assembled final video.
      updates.finalVideo = { url: null, status: 'pending' };
    }

    const updatedJob = await jobStore.updateJob(job.id, updates);
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating voice-over:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Voice-over generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-video', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const promptMismatch = findScenePromptMismatch(job);
  if (promptMismatch) {
    return res.status(400).json({ error: promptMismatch });
  }

  // Optional: restrict this run to exactly one scene, by its zero-based
  // index, e.g. so a single, bounded, real test can generate Scene 1 only
  // — every other scene (Scene 2 included) is guaranteed to never be
  // submitted to the provider for this call. Omitting sceneIndex generates
  // every scene, unchanged from existing behavior.
  let sceneIndex = null;
  if (req.body && req.body.sceneIndex !== undefined) {
    sceneIndex = req.body.sceneIndex;
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= job.videoPrompts.length) {
      return res.status(400).json({
        error:
          `sceneIndex must be an integer between 0 and ${job.videoPrompts.length - 1} for this job. ` +
          'No Runway request was made.',
      });
    }
  }

  // TEMPORARY safety cap (see TEMP_GENERATE_VIDEO_SCENE_CAP above) — only
  // applies to a full-job run (no sceneIndex given), since that is the only
  // case that could submit more than one paid request in a single call.
  // Refuses outright, before any provider call, rather than silently
  // truncating a larger job down to this count.
  if (sceneIndex === null && job.videoPrompts.length !== TEMP_GENERATE_VIDEO_SCENE_CAP) {
    return res.status(400).json({
      error:
        `Video generation is temporarily capped at exactly ${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes ` +
        `for testing. This job has ${job.videoPrompts.length} video prompts/scenes — reduce it to ` +
        `exactly ${TEMP_GENERATE_VIDEO_SCENE_CAP}, or pass sceneIndex to generate one specific scene. ` +
        'No Runway request was made.',
      videoPromptsCount: job.videoPrompts.length,
      requiredSceneCount: TEMP_GENERATE_VIDEO_SCENE_CAP,
    });
  }

  if (!Array.isArray(job.images) || job.images.length === 0) {
    return res.status(400).json({
      error: 'job has no generated scene images yet — generate images before generating video',
    });
  }

  const activeProvider = videoGeneration.getProvider();

  if (activeProvider.name === 'runway' && !process.env.RUNWAYML_API_SECRET) {
    return res.status(500).json({ error: 'RUNWAYML_API_SECRET is not configured' });
  }

  try {
    const existingClips =
      job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

    const result = await videoGeneration.generateVideoForScenes({
      videoPrompts: job.videoPrompts,
      images: job.images,
      existingClips,
      sceneIndex,
    });

    const allCompleted = result.clips.length > 0 && result.clips.every((clip) => clip.status === 'completed');
    const anyProcessing = result.clips.some((clip) => clip.status === 'processing');
    const anyFailed = result.clips.some((clip) => clip.status === 'failed');
    // A scene left untouched by a sceneIndex-restricted run stays
    // 'not_started' — that must not be reported as an overall 'failed'
    // status, since it was never submitted at all.
    const overallStatus = allCompleted ? 'completed' : anyProcessing ? 'processing' : anyFailed ? 'failed' : 'not_started';

    const videoGenerationField = {
      provider: activeProvider.name,
      status: overallStatus,
      clips: result.clips,
      error: overallStatus === 'failed' ? 'One or more scenes failed to generate a video clip.' : null,
    };

    // finalVideo is never set here, even when every scene's clip is
    // 'completed' — that is many separate short clips, not one final
    // assembled video. POST /api/jobs/:id/assemble-video (backend/
    // video-assembly.js) is the separate, real assembly/stitching step that
    // actually produces finalVideo.
    const updatedJob = await jobStore.updateJob(job.id, { videoGeneration: videoGenerationField });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating video:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Video generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/assemble-video', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  // Already assembled — return the existing result unchanged rather than
  // re-running ffmpeg on every call (mirrors the assembleFinalVideo Agent
  // tool's own idempotency check; see its comment there).
  if (job.finalVideo && job.finalVideo.status === 'completed' && job.finalVideo.url) {
    return res.json(job);
  }

  const blocker = findFinalVideoBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  try {
    const finalVideo = await assembleAndStoreFinalVideo(job, job.id);
    const updatedJob = await jobStore.updateJob(job.id, { finalVideo });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error assembling final video:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Final video assembly failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/advance', async (req, res) => {
  const result = await jobStore.advanceJob(req.params.id);

  if (result.error === 'not_found') {
    return res.status(404).json({ error: 'job not found' });
  }

  if (result.error === 'confirmation_required') {
    return res
      .status(403)
      .json({ error: 'job must be confirmed before it can be completed', job: result.job });
  }

  if (result.error === 'missing_required_output') {
    const isRenderingBlock = result.missingFields.includes('finalVideo');
    return res.status(400).json({
      error: isRenderingBlock
        ? 'Cannot mark this job COMPLETED: there is no real, single rendered final video for this ' +
          'job yet. POST /api/jobs/:id/assemble-video once every scene\'s video clip is completed. ' +
          'It stays at the READY stage until that succeeds.'
        : `Cannot advance: the current stage (${result.job.status}) is missing required output: ` +
          `${result.missingFields.join(', ')}.`,
      missingFields: result.missingFields,
      job: result.job,
    });
  }

  if (result.error === 'no_next_stage') {
    return res.status(400).json({ error: 'job has no next stage', job: result.job });
  }

  res.json(result.job);
});

// Only start a listening server when run directly (local dev / `npm start`).
// When this file is imported instead (e.g. by Vercel's Node.js serverless
// runtime), the exported `app` is invoked per-request and must not bind a
// port itself.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// executeTool is attached to the exported app (rather than changing the
// export shape to an object) purely so it can be unit-tested directly —
// app itself is still the plain Express app everywhere else (local dev,
// Vercel's serverless runtime, and existing tests that `require('./server')`
// expecting the listenable app).
module.exports = app;
module.exports.executeTool = executeTool;
