const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jobStore = require('./job-store');

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
  'voiceover',
  'subtitles',
  'music',
  'thumbnail',
  'description',
];

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
        voiceover: { type: 'string' },
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
      'It also cannot leave SCRIPTING without a non-empty script, leave SCENE PLANNING without ' +
      'non-empty scenes and characters, or leave ASSET GENERATION without non-empty imagePrompts ' +
      'and videoPrompts — use updateVideoJob to fill those in first if this call reports them missing.',
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

function executeTool(name, jobId, input) {
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
    const job = jobStore.updateJob(jobId, updates);
    return JSON.stringify(job || { error: 'job not found' });
  }

  if (name === 'advanceVideoJobStage') {
    const result = jobStore.advanceJob(jobId);

    if (result.error === 'not_found') {
      return JSON.stringify({ error: 'job not found' });
    }
    if (result.error === 'confirmation_required') {
      return JSON.stringify({
        error:
          'The job cannot be completed until the user has explicitly confirmed the final production summary.',
        job: result.job,
      });
    }
    if (result.error === 'missing_required_output') {
      return JSON.stringify({
        error:
          `The job cannot advance out of ${result.job.status} because the following required output is missing or empty: ` +
          `${result.missingFields.join(', ')}. Use updateVideoJob to fill these in first.`,
        missingFields: result.missingFields,
        job: result.job,
      });
    }
    if (result.error === 'no_next_stage') {
      return JSON.stringify({ error: 'job has no next stage', job: result.job });
    }

    return JSON.stringify(result.job);
  }

  if (name === 'confirmVideoJob') {
    const job = jobStore.updateJob(jobId, { confirmed: true });
    return JSON.stringify(job || { error: 'job not found' });
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

app.use(express.json());
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON in request body' });
  }
  next(err);
});
app.use(express.static(path.resolve(__dirname, '..', 'frontend')));

app.post('/api/agent', async (req, res) => {
  const { message, conversationHistory, jobId: requestedJobId } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const existingJob = requestedJobId ? jobStore.getJob(requestedJobId) : null;
  const jobId = existingJob ? existingJob.id : jobStore.createJob().id;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const messages = [...history, { role: 'user', content: message }];

  function buildSystemPrompt() {
    const currentJob = jobStore.getJob(jobId);
    return (
      SYSTEM_PROMPT_BASE +
      '\n\n## Current Video Production Job\n' +
      'This is the current state of the video production job for this conversation. ' +
      'Use the updateVideoJob, advanceVideoJobStage, and confirmVideoJob tools to keep it accurate.\n\n' +
      JSON.stringify(currentJob)
    );
  }

  try {
    let response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: buildSystemPrompt(),
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
      messages.push({
        role: 'user',
        content: toolUseBlocks.map((tool) => ({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: executeTool(tool.name, jobId, tool.input),
        })),
      });

      response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1024,
        system: buildSystemPrompt(),
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

app.get('/api/jobs', (req, res) => {
  res.json(jobStore.listJobs());
});

app.post('/api/jobs', (req, res) => {
  const job = jobStore.createJob();
  res.status(201).json(job);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.patch('/api/jobs/:id', (req, res) => {
  const job = jobStore.updateJob(req.params.id, req.body || {});

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.post('/api/jobs/:id/advance', (req, res) => {
  const result = jobStore.advanceJob(req.params.id);

  if (result.error === 'not_found') {
    return res.status(404).json({ error: 'job not found' });
  }

  if (result.error === 'confirmation_required') {
    return res
      .status(403)
      .json({ error: 'job must be confirmed before it can be completed', job: result.job });
  }

  if (result.error === 'missing_required_output') {
    return res.status(400).json({
      error:
        `Cannot advance: the current stage (${result.job.status}) is missing required output: ` +
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
