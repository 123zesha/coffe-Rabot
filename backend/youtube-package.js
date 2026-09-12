// "YouTube Publishing Package" (optional): generates a real, original
// YouTube title/description/tags/thumbnail concept for the CURRENT job's
// own finished script/topic/style — never anything to do with any reference
// video the user may have used purely for storytelling-format inspiration.
// This module is deliberately never given referenceVideoAnalysis.summary or
// referenceVideoUrl at all (see its caller in server.js) — not just told
// not to copy them, but never shown them in the first place, so there is no
// channel for the finished package to leak anything from the original
// reference video.
//
// This is deliberately independent of the Anthropic tool-use loop in
// server.js — it makes its own, separate Claude API call, exactly like
// reference-video.js/image-generation.js/voiceover-generation.js each make
// their own independent calls — so the main conversation's tool wiring, and
// the stage/confirmation gates in job-store.js, are untouched.
//
// No new paid service: this reuses the exact same Anthropic integration
// (API key, model) already central to the whole app for its text half. The
// thumbnail IMAGE itself is generated separately, by
// backend/image-generation.js's generateThumbnailImage, reusing the app's
// existing OpenAI image integration.

const Anthropic = require('@anthropic-ai/sdk');

const PACKAGE_MODEL = 'claude-opus-5';

let cachedClient = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

// Defensively extracts the first {...} JSON object from Claude's reply —
// never assumes the model returned ONLY JSON with nothing else around it
// (and never assumes it returned valid JSON at all).
function extractJsonObject(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function sanitizeStringArray(value, maxItems) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function sanitizeString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function failedResult(error) {
  return {
    status: 'failed',
    titles: [],
    description: null,
    tags: [],
    thumbnailConcept: null,
    thumbnailText: null,
    error,
  };
}

// Produces { status: 'completed', titles, description, tags,
// thumbnailConcept, thumbnailText, error: null } or a failedResult(...)
// shape. Never fabricates a package: a missing script, an unparseable model
// response, or one missing a required part fails honestly instead of
// guessing.
async function generateYoutubeTextPackage({ topic, duration, language, storyStyle, script }) {
  const trimmedScript = typeof script === 'string' ? script.trim() : '';
  if (!trimmedScript) {
    return failedResult('No script to base a YouTube package on.');
  }

  const contextLines = [];
  if (topic) contextLines.push(`Topic/story idea: ${topic}`);
  if (duration) contextLines.push(`Duration: ${duration}`);
  if (language) contextLines.push(`Language: ${language}`);
  if (storyStyle) contextLines.push(`Style: ${storyStyle}`);
  contextLines.push(`Final script:\n${trimmedScript}`);

  const prompt =
    'You are writing a YouTube publishing package for the ORIGINAL video described below — a real, ' +
    "finished script a creator has already produced. Base everything ONLY on the material given below; " +
    'never reference, borrow from, or assume any other video exists.\n\n' +
    'Respond with ONLY a single JSON object (no other text, no markdown fences) with exactly this shape:\n' +
    '{\n' +
    '  "titles": [string, string, string],\n' +
    '  "description": string,\n' +
    '  "tags": [string, ...],\n' +
    '  "thumbnailConcept": string,\n' +
    '  "thumbnailText": string\n' +
    '}\n\n' +
    'Requirements:\n' +
    '- titles: exactly 3 distinct, strong, click-worthy YouTube title options, each honestly describing ' +
    'this specific video.\n' +
    '- description: an SEO-friendly YouTube video description (a few short paragraphs) that accurately ' +
    'describes THIS video only.\n' +
    '- tags: 8-15 relevant single/short-phrase keywords for this specific video.\n' +
    '- thumbnailConcept: a short description of an original 16:9 thumbnail image composition for this ' +
    'video (subject, framing, mood, colors) — inspired only by this video\'s own content.\n' +
    '- thumbnailText: a very short (2-5 word) text overlay suitable for the thumbnail, or an empty ' +
    'string if none fits naturally.\n\n' +
    'Everything must be entirely original to this specific video — never invent a connection to any ' +
    'other video, channel, or existing media.\n\n' +
    contextLines.join('\n');

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: PACKAGE_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = Array.isArray(response.content)
      ? response.content.find((block) => block.type === 'text')
      : null;
    const parsed = textBlock ? extractJsonObject(textBlock.text) : null;

    if (!parsed) {
      return failedResult('The package generation call did not return valid JSON.');
    }

    const titles = sanitizeStringArray(parsed.titles, 3);
    const description = sanitizeString(parsed.description);
    const tags = sanitizeStringArray(parsed.tags, 20);
    const thumbnailConcept = sanitizeString(parsed.thumbnailConcept);
    const thumbnailText = typeof parsed.thumbnailText === 'string' ? parsed.thumbnailText.trim() : '';

    if (titles.length === 0 || !description || !thumbnailConcept) {
      return failedResult('The package generation call returned an incomplete result.');
    }

    return { status: 'completed', titles, description, tags, thumbnailConcept, thumbnailText, error: null };
  } catch (error) {
    return failedResult((error && error.message) || 'Unknown error generating the YouTube package.');
  }
}

module.exports = { generateYoutubeTextPackage, extractJsonObject, PACKAGE_MODEL };
