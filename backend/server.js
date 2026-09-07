const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jobStore = require('./job-store');
const imageGeneration = require('./image-generation');
const voiceoverGeneration = require('./voiceover-generation');
const videoGeneration = require('./video-generation');

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

  return null;
}

const client = new Anthropic();

const VIDEO_OPTIONS = fs.readFileSync(
  path.resolve(__dirname, '..', 'data', 'video-options.json'),
  'utf8'
);

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
        imagePrompts: { type: 'array', items: {} },
        videoPrompts: { type: 'array', items: {} },
        voiceStyle: { type: 'string' },
        subtitles: { type: 'string' },
        music: { type: 'string' },
        thumbnail: { type: 'string' },
        description: { type: 'string' },
      },
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
      'successfully rendered final video file. Individual scene video clips can be generated, ' +
      'but they are not yet automatically assembled into one final video file, so this call ' +
      'will currently always report finalVideo missing when leaving READY — when it does, tell ' +
      'the user plainly that the final video is not assembled/available yet and their job stays ' +
      'at the READY stage; never say the video has been produced, rendered, or completed.',
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
      'generating images, and never call it again to retry a scene that already failed unless the ' +
      'user explicitly asks again. sceneIndex is REQUIRED: it is the zero-based scene number to ' +
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
            'Individual scene clips may exist, but they are not automatically combined into one ' +
            'final video file yet — tell the user their video is not produced/rendered yet and the ' +
            'job stays at the READY stage. Do not call updateVideoJob for this; it cannot be filled ' +
            'in manually.'
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

  if (!job.script || !job.script.trim()) {
    return res.status(400).json({ error: 'job has no script to generate a voice-over from' });
  }

  if (job.script.trim().length < jobStore.MIN_SCRIPT_LENGTH) {
    return res.status(400).json({
      error: `the script is too short to be an approved, complete script (needs at least ${jobStore.MIN_SCRIPT_LENGTH} characters) — finish scripting before generating a voice-over`,
    });
  }

  if (job.voiceStyle === 'none') {
    return res.status(400).json({ error: 'this job is set to no voice-over (text only)' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const voiceover = await voiceoverGeneration.generateVoiceover({
      script: job.script,
      voiceStyle: job.voiceStyle,
    });

    const updatedJob = await jobStore.updateJob(job.id, { voiceover });
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
    // assembled video. Producing finalVideo requires a real, separate
    // assembly/stitching step that does not exist yet (see
    // backend/video-generation.js and job-store.js's finalVideo comment).
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
        ? 'Cannot mark this job COMPLETED: individual scene clips are not automatically assembled ' +
          'into one final video yet, so there is no real, single rendered final video for this ' +
          'job. It stays at the READY stage.'
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
