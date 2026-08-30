const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic();

const VIDEO_OPTIONS = fs.readFileSync(
  path.resolve(__dirname, '..', 'data', 'video-options.json'),
  'utf8'
);

const SYSTEM_PROMPT =
  fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8') +
  '\n\n## Available Video Production Options\n' +
  'These are the ONLY video production options you may offer, confirm, or use. ' +
  'Do not invent, assume, or suggest any language, duration, video style, story/video type, ' +
  'voice-over option, visual style, or output option that is not listed below.\n\n' +
  VIDEO_OPTIONS;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble reaching the AI Agent right now. Please try again in a moment.";

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'frontend')));

app.post('/api/agent', async (req, res) => {
  const { message, conversationHistory } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const messages = [...history, { role: 'user', content: message }];

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const textBlock = response.content.find((block) => block.type === 'text');

    res.json({
      reply: textBlock ? textBlock.text : '',
      conversationHistory: [...messages, { role: 'assistant', content: response.content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('Claude API authentication failed.');
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error('Claude API rate limited.');
    } else if (error instanceof Anthropic.APIConnectionError) {
      console.error('Claude API connection error.');
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}: ${error.name}`);
    } else {
      console.error('Unexpected error calling Claude API:', error.message);
    }

    res.json({
      reply: FALLBACK_REPLY,
      conversationHistory: history,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
