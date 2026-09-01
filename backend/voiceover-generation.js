// Generates a real voice-over audio file through the OpenAI text-to-speech
// API from the job's script. This module is deliberately independent of the
// Anthropic tool-use loop in server.js — it is only ever invoked through its
// own REST route, so the conversational agent, its tools, and the
// stage/confirmation gates in server.js and job-store.js are untouched.

const OpenAI = require('openai');

// gpt-4o-mini-tts is OpenAI's current general-purpose TTS model (verified
// against the OpenAI API docs/SDK type definitions at integration time).
const TTS_MODEL = 'gpt-4o-mini-tts';

// The OpenAI TTS API accepts at most 4096 characters of input per request. A
// real video script easily exceeds that, so longer scripts are split into
// sentence-bounded chunks, synthesized separately, and the resulting audio
// is concatenated into one file.
const MAX_TTS_INPUT_LENGTH = 4096;

// Maps this project's existing voice-style option values (see
// data/video-options.json -> voiceOverOptions) to OpenAI's built-in TTS
// voices, so the dashboard/agent never need to know OpenAI-specific names.
const VOICE_MAP = {
  'male-warm': 'onyx',
  'male-energetic': 'verse',
  'female-warm': 'shimmer',
  'female-professional': 'nova',
  'neutral-narrator': 'alloy',
};
const DEFAULT_VOICE = 'alloy';

let cachedClient = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set.');
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return cachedClient;
}

function resolveVoice(voiceStyle) {
  return VOICE_MAP[voiceStyle] || DEFAULT_VOICE;
}

function describeError(error) {
  if (error instanceof OpenAI.APIError) {
    return `${error.status || ''} ${error.message}`.trim();
  }
  return (error && error.message) || 'Unknown error generating voice-over.';
}

// Splits on sentence boundaries so no chunk cuts a sentence mid-way; a
// single sentence longer than the limit (rare) is hard-split as a fallback.
function chunkScript(script, maxLength) {
  const sentences = script.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [script];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) {
      if (current.trim()) {
        chunks.push(current.trim());
      }
      if (sentence.length > maxLength) {
        for (let i = 0; i < sentence.length; i += maxLength) {
          chunks.push(sentence.slice(i, i + maxLength).trim());
        }
        current = '';
      } else {
        current = sentence;
      }
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

// Synthesizes the full script into one MP3 audio file, returning it as a
// data URI. Only ever marks the result 'completed' when OpenAI actually
// returned audio data for every chunk; any failure is recorded as 'failed'
// with an error message, never a fabricated URL.
async function generateVoiceover({ script, voiceStyle }) {
  const client = getClient();
  const voice = resolveVoice(voiceStyle);
  const chunks = chunkScript(script, MAX_TTS_INPUT_LENGTH);

  try {
    const buffers = [];

    for (const chunk of chunks) {
      const response = await client.audio.speech.create({
        model: TTS_MODEL,
        voice,
        input: chunk,
        response_format: 'mp3',
      });
      buffers.push(Buffer.from(await response.arrayBuffer()));
    }

    const audioBuffer = Buffer.concat(buffers);
    if (audioBuffer.length === 0) {
      throw new Error('OpenAI did not return audio data.');
    }

    return {
      url: `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`,
      status: 'completed',
      voice,
      voiceStyle: voiceStyle || '',
    };
  } catch (error) {
    console.error('OpenAI voice-over generation error:', JSON.stringify({ message: describeError(error) }, null, 2));
    return { url: null, status: 'failed', voice, voiceStyle: voiceStyle || '', error: describeError(error) };
  }
}

module.exports = { generateVoiceover, TTS_MODEL };
