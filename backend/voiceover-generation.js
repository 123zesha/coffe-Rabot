// Generates a real voice-over audio file through the OpenAI text-to-speech
// API from the job's script. This module is deliberately independent of the
// Anthropic tool-use loop in server.js — it is only ever invoked through its
// own REST route, so the conversational agent, its tools, and the
// stage/confirmation gates in server.js and job-store.js are untouched.
//
// Adaptive delivery: the narration's tone, energy, pacing, and pauses
// automatically adapt to the job's own storyStyle/topic/videoMode — see
// resolveVoiceDirection below — instead of always reading in one fixed,
// neutral style regardless of content. The narrator's identity (the
// selected `voice`) and the chunking/concatenation pipeline are unaffected;
// only the OpenAI TTS `instructions`/`speed` parameters change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const OpenAI = require('openai');
const videoStorage = require('./video-storage');
const { ffmpegPath } = require('./video-assembly');

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

// Ordered mood/delivery profiles this app can automatically recognize from
// a job's own storyStyle/topic text — both free-form fields the
// conversational agent already fills in from how the user described their
// video (see job-store.js's createDefaultJob comment; storyStyle is never
// constrained to a fixed enum). Checked in order; the first profile whose
// keyword appears anywhere in the combined, lowercased storyStyle+topic
// text is used. This only ever changes HOW the narration is delivered
// (tone, energy, pacing, pauses via the TTS `instructions`/`speed`
// params) — never WHAT is said, the voice identity, or the chunking/
// concatenation pipeline above.
const VOICE_MOOD_PROFILES = [
  {
    keywords: ['suspense', 'thriller', 'mystery', 'tense', 'tension', 'horror', 'scary'],
    instructions:
      'Deliver with controlled tension and restraint: measured pacing, and meaningful pauses ' +
      'before key moments or reveals, with a slightly hushed, focused intensity.',
    speed: 0.95,
  },
  {
    keywords: ['motivat', 'inspir', 'uplift', 'empower', 'encourage'],
    instructions:
      'Speak with confident, energetic warmth: inspiring and uplifting, with steady forward ' +
      'momentum and genuine enthusiasm.',
    speed: 1.05,
  },
  {
    keywords: ['sad', 'grief', 'loss', 'heartbreak', 'tragic', 'tragedy', 'mourning', 'sorrow'],
    instructions:
      'Speak softly and gently, with slightly slower pacing and natural, unhurried pauses ' +
      'between thoughts, letting the emotion come through warmly and subtly.',
    speed: 0.9,
  },
  {
    keywords: ['happy', 'joy', 'cheerful', 'fun', 'playful', 'delight', 'upbeat'],
    instructions: 'Sound warm and a little brighter, with a touch more energy and a natural smile in the voice.',
    speed: 1.03,
  },
  {
    keywords: ['emotional', 'heartfelt', 'touching', 'moving', 'poignant'],
    instructions:
      'Speak warmly and gently with genuine emotional warmth, slightly slower than a neutral ' +
      'narration, letting the feeling come through naturally rather than performed.',
    speed: 0.95,
  },
  {
    keywords: [
      'documentary',
      'informational',
      'news',
      'educational',
      'explainer',
      'factual',
      'tutorial',
      'how-to',
      'howto',
    ],
    instructions:
      'Speak calmly and clearly with a natural, authoritative narration style: steady pacing, ' +
      'confident delivery, no dramatization.',
    speed: 1,
  },
  {
    keywords: ['children', 'child', 'kids', "kid's", 'bedtime'],
    instructions:
      'Speak in a warm, friendly, and gently expressive way: engaging like telling a bedtime ' +
      'story, but natural and unhurried, never exaggerated or cartoonish.',
    speed: 0.97,
  },
  {
    keywords: ['vlog', 'review', 'update', 'personal'],
    instructions: 'Speak in a clear, friendly, conversational tone with natural, approachable pacing.',
    speed: 1,
  },
];

const DEFAULT_VOICE_MOOD = {
  instructions: 'Speak with warm, natural storytelling energy, with gentle natural pauses between ideas.',
  speed: 1,
};

// videoMode 'simple-story' is this app's dedicated English-learning /
// listening-practice format (see data/video-options.json's own
// description of that mode) — clarity always takes priority for it, so its
// pace is capped at this comfortable-for-learners ceiling regardless of
// how energetic the story's own mood profile would otherwise be.
const ENGLISH_LEARNING_MAX_SPEED = 0.92;

// Composes ONE `instructions` string (plus a modest `speed` adjustment,
// OpenAI's TTS speed range is 0.25-4.0) applied identically to every chunk
// of the same voice-over, so the narrator's identity and delivery style
// never shifts mid-track. Deliberately not a separate style per chunk/
// scene: chunks are just length-bounded slices of one continuous script
// (see chunkScript above), not scene boundaries, and generating a distinct
// direction per chunk would risk an inconsistent-sounding narrator without
// any real per-chunk signal to base it on beyond the same job-level text
// used here. gpt-4o-mini-tts (unlike tts-1/tts-1-hd) both accepts
// `instructions` and reads the script's own words, so real dialogue/
// emotional beats within the text still come through naturally under one
// consistent overall direction.
function resolveVoiceDirection({ storyStyle, videoMode, topic }) {
  const haystack = `${storyStyle || ''} ${topic || ''}`.toLowerCase();
  const profile =
    VOICE_MOOD_PROFILES.find((candidate) => candidate.keywords.some((keyword) => haystack.includes(keyword))) ||
    DEFAULT_VOICE_MOOD;

  const parts = [profile.instructions];
  let speed = profile.speed;

  if (videoMode === 'simple-story') {
    parts.push(
      'This is a listening-practice, English-learning story: prioritize clear, precise ' +
        'pronunciation and a comfortable, slightly slower pace, with natural pauses between ' +
        'sentences so every word is easy to follow.'
    );
    speed = Math.min(speed, ENGLISH_LEARNING_MAX_SPEED);
  }

  parts.push(
    'Maintain one natural, human, consistent narrator personality throughout the whole ' +
      'recording — never robotic, never over-acted. Let any emotional shifts emerge smoothly ' +
      'and naturally from the words themselves.'
  );

  return { instructions: parts.join(' '), speed };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || '').toString().trim().slice(-2000);
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

// OpenAI's TTS API returns each chunk as its own COMPLETE, independent MP3
// file (its own header and, per the MP3 format's own encoder-priming
// convention, a small amount of silence at the very start/end). Gluing
// those independent files together with a raw byte concatenation (what
// this function replaces) leaves every later chunk's own file header sitting
// mid-stream as if it were audio data, and the player/decoder has to guess
// frame boundaries across each seam — this is exactly the "invalid
// concatenated file" shape ffmpeg itself flags, and in practice it can
// produce short garbled/dropout artifacts right at each chunk boundary
// (audible as an unnatural warble or "hollow" moment every ~30-60s in a
// long narration, i.e. every time the script crossed a 4096-character
// chunk boundary). Decoding each chunk to real audio samples first, then
// joining those samples and encoding the result ONCE, produces one genuine,
// gapless audio stream with no embedded headers in the middle — never a new
// TTS call, purely local ffmpeg processing on audio OpenAI already
// generated and this app already paid for.
async function concatenateAudioChunks(buffers) {
  if (buffers.length === 1) {
    return buffers[0];
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-concat-'));
  try {
    const wavPaths = [];
    for (let i = 0; i < buffers.length; i++) {
      const chunkPath = path.join(workDir, `chunk-${i}.mp3`);
      const wavPath = path.join(workDir, `chunk-${i}.wav`);
      fs.writeFileSync(chunkPath, buffers[i]);
      await runFfmpeg(['-y', '-i', chunkPath, wavPath]);
      wavPaths.push(wavPath);
    }

    const outPath = path.join(workDir, 'concatenated.mp3');
    const inputArgs = wavPaths.flatMap((wavPath) => ['-i', wavPath]);
    const filterInputs = wavPaths.map((_, i) => `[${i}:a]`).join('');
    await runFfmpeg([
      '-y',
      ...inputArgs,
      '-filter_complex',
      `${filterInputs}concat=n=${wavPaths.length}:v=0:a=1[out]`,
      '-map',
      '[out]',
      '-c:a',
      'libmp3lame',
      outPath,
    ]);

    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

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

// Synthesizes the full script into one MP3 audio file, storing it OUTSIDE
// the job record (video-storage.js — Vercel Blob in production, a local
// file in dev/tests) and returning only that short reference URL. A real
// 15-20 minute narration track's audio easily runs to several MB; embedding
// that directly as a base64 data: URI in the job record risks exceeding
// Redis/Upstash's per-request payload limit (see job-store.js's comment),
// silently discarding an already-generated, already-paid-for result. Only
// ever marks the result 'completed' when OpenAI actually returned audio
// data for every chunk and it was stored successfully; any failure is
// recorded as 'failed' with an error message, never a fabricated URL.
async function generateVoiceover({ script, voiceStyle, jobId, storyStyle, videoMode, topic }) {
  const client = getClient();
  const voice = resolveVoice(voiceStyle);
  const chunks = chunkScript(script, MAX_TTS_INPUT_LENGTH);
  const { instructions, speed } = resolveVoiceDirection({ storyStyle, videoMode, topic });

  try {
    // Chunks are synthesized concurrently, not sequentially — a long script
    // (e.g. a 15-20 minute story) can produce several chunks, and awaiting
    // them one at a time risks exceeding the hosting platform's request
    // timeout. Promise.all preserves chunks' input order in its results
    // regardless of completion order, so concatenation below stays correct.
    // The same instructions/speed go to every chunk so the adaptive
    // delivery style stays one consistent narrator voice across the whole
    // track, never shifting between chunks.
    const buffers = await Promise.all(
      chunks.map(async (chunk) => {
        const response = await client.audio.speech.create({
          model: TTS_MODEL,
          voice,
          input: chunk,
          response_format: 'mp3',
          instructions,
          speed,
        });
        return Buffer.from(await response.arrayBuffer());
      })
    );

    const audioBuffer = await concatenateAudioChunks(buffers);
    if (audioBuffer.length === 0) {
      throw new Error('OpenAI did not return audio data.');
    }

    const url = await videoStorage.storeAudioFile(audioBuffer, jobId);

    return {
      url,
      status: 'completed',
      voice,
      voiceStyle: voiceStyle || '',
    };
  } catch (error) {
    console.error('OpenAI voice-over generation error:', JSON.stringify({ message: describeError(error) }, null, 2));
    return { url: null, status: 'failed', voice, voiceStyle: voiceStyle || '', error: describeError(error) };
  }
}

module.exports = { generateVoiceover, resolveVoiceDirection, concatenateAudioChunks, TTS_MODEL };
