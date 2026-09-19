// Generates a real .srt subtitle file by transcribing the job's OWN,
// already-generated voice-over audio — NEVER guessed or estimated from the
// script's text or length. This module is deliberately independent of the
// Anthropic tool-use loop in server.js, exactly like voiceover-generation.js
// and image-generation.js each make their own independent OpenAI calls.
//
// Why transcription, not script-based timing: the voice-over
// (backend/voiceover-generation.js) is synthesized as one continuous audio
// track, and the OpenAI TTS call itself returns no word/sentence timestamps
// at all. There is no honest way to compute caption timing from the script
// text alone (sentence length is a poor proxy for real spoken duration —
// pacing, pauses, and pronunciation all vary). The ONLY accurate source of
// truth for when each word is actually spoken is the real, rendered audio
// — so this module transcribes that audio with OpenAI's Whisper
// transcription endpoint, which returns real, measured timestamps, and
// never estimates or interpolates timing itself.
//
// No new paid service: this reuses the exact same OPENAI_API_KEY/provider
// already used for the voice-over and scene images. It IS a new BILLABLE
// endpoint on that same provider (audio transcription) that this codebase
// has not called before — flagged here and in the implementation plan, not
// hidden.
//
// response_format: 'srt' asks OpenAI to return an already-formatted SRT
// file directly (verified against the installed `openai` SDK's own type
// definitions in node_modules/openai/resources/audio/transcriptions.d.ts)
// rather than this module hand-rolling SRT timecode formatting itself from
// segment data — fewer places for a subtle correctness bug (timecode
// rounding, multi-hour formatting, sequence numbering) to creep in, which
// matters more here than the trivial cost difference between response
// formats. whisper-1 is used (rather than the newer gpt-4o-transcribe
// family) because those newer models only support response_format: 'json'
// per the same type definitions — they cannot return 'srt' or
// 'verbose_json' timestamps at all.

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');
const videoStorage = require('./video-storage');

const TRANSCRIPTION_MODEL = 'whisper-1';

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

function describeError(error) {
  if (error instanceof OpenAI.APIError) {
    return `${error.status || ''} ${error.message}`.trim();
  }
  return (error && error.message) || 'Unknown error generating subtitles.';
}

// Reads the voice-over's real audio bytes into an uploadable file for the
// transcription call. job.voiceover.url is one of three shapes, matching
// every place voiceover-generation.js's storeAudioFile call can produce
// (see video-storage.js): a real https:// URL (Vercel Blob in production),
// a /generated/... local reference (the no-Blob-token dev/test fallback,
// read straight from disk — this server has no fixed, known base URL to
// fetch its own static route from), or a base64 data: URI (kept for
// backward compatibility with any job created before voice-over audio was
// moved out of the job record). Returns null for anything else, or for a
// reference that decodes/downloads to zero bytes — never guesses at
// partial/malformed input.
async function resolveVoiceoverAudioFile(voiceoverUrl) {
  let buffer;
  let mimeType = 'audio/mpeg';

  if (voiceoverUrl.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(voiceoverUrl);
    if (!match) {
      return null;
    }
    mimeType = match[1];
    buffer = Buffer.from(match[2], 'base64');
  } else if (voiceoverUrl.startsWith('/generated/')) {
    const filePath = path.join(videoStorage.GENERATED_DIR, voiceoverUrl.slice('/generated/'.length));
    if (!fs.existsSync(filePath)) {
      return null;
    }
    buffer = fs.readFileSync(filePath);
  } else if (/^https?:\/\//i.test(voiceoverUrl)) {
    const response = await fetch(voiceoverUrl);
    if (!response.ok) {
      return null;
    }
    buffer = Buffer.from(await response.arrayBuffer());
    mimeType = response.headers.get('content-type') || mimeType;
  } else {
    return null;
  }

  if (!buffer || buffer.length === 0) {
    return null;
  }

  const extension = mimeType.split('/')[1] || 'mp3';
  return toFile(buffer, `voiceover.${extension}`, { type: mimeType });
}

function failedResult(error) {
  return { status: 'failed', format: 'srt', content: null, error };
}

// Produces { status: 'completed', format: 'srt', content, error: null } or
// failedResult(...). Never fabricates subtitle content: a missing/invalid
// voice-over audio, an empty transcription, or an API failure all fail
// honestly instead of guessing at timing or text.
async function generateSubtitles({ voiceoverUrl }) {
  if (typeof voiceoverUrl !== 'string' || !voiceoverUrl) {
    return failedResult('No real voice-over audio is available to transcribe yet.');
  }

  const audioFile = await resolveVoiceoverAudioFile(voiceoverUrl);
  if (!audioFile) {
    return failedResult('The voice-over audio could not be read for transcription.');
  }

  try {
    const client = getClient();
    const srt = await client.audio.transcriptions.create({
      file: audioFile,
      model: TRANSCRIPTION_MODEL,
      response_format: 'srt',
    });

    const content = typeof srt === 'string' ? srt.trim() : '';
    if (!content) {
      return failedResult('The transcription call did not return any subtitle content.');
    }

    return { status: 'completed', format: 'srt', content, error: null };
  } catch (error) {
    console.error('OpenAI subtitle transcription error:', JSON.stringify({ message: describeError(error) }, null, 2));
    return failedResult(describeError(error));
  }
}

module.exports = { generateSubtitles, TRANSCRIPTION_MODEL };
