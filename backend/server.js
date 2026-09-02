const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jobStore = require('./job-store');
const imageGeneration = require('./image-generation');
const voiceoverGeneration = require('./voiceover-generation');

const app = express();
const PORT = process.env.PORT || 3000;

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
    name: 'advanceVideoJobStage',
    description:
      'Move the current video production job to its next production stage ' +
      '(NEW -> SCRIPTING -> SCENE PLANNING -> ASSET GENERATION -> EDITING -> READY -> COMPLETED). ' +
      'The job cannot advance into COMPLETED unless it has already been confirmed by the user. ' +
      'It also cannot leave SCRIPTING without a complete script (a short fragment is not enough), ' +
      'leave SCENE PLANNING without non-empty scenes and characters, leave ASSET GENERATION ' +
      'without non-empty imagePrompts and videoPrompts, or leave READY without a real, ' +
      'successfully rendered final video file. Video rendering is not implemented yet, so this ' +
      'call will currently always report finalVideo missing when leaving READY — when it does, ' +
      'tell the user plainly that final video rendering is not available yet and their job stays ' +
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
          ? 'The job cannot be marked COMPLETED because no real rendered final video exists yet. ' +
            'Video rendering is not implemented in this system — tell the user their video is not ' +
            'produced/rendered yet and the job stays at the READY stage. Do not call updateVideoJob ' +
            'for this; it cannot be filled in manually.'
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

  if (!Array.isArray(job.imagePrompts) || job.imagePrompts.length === 0) {
    return res.status(400).json({ error: 'job has no imagePrompts to generate images from' });
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
        ? 'Cannot mark this job COMPLETED: video rendering is not implemented yet, so there is no ' +
          'real rendered final video for this job. It stays at the READY stage.'
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

module.exports = app;
