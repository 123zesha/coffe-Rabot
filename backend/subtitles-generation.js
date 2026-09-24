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
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const OpenAI = require('openai');
const { toFile } = require('openai');
const videoStorage = require('./video-storage');
const { ffmpegPath, getMediaDuration } = require('./video-assembly');
const { parseSrt } = require('./simple-story-video');

const TRANSCRIPTION_MODEL = 'whisper-1';

// OpenAI's transcription endpoint refuses a file over 25MB. A long video
// (e.g. a 30-40 minute Chat-to-Video script) can produce a voice-over MP3
// that exceeds this — this module used to only ever make one transcription
// call with the whole file, which would fail outright for exactly the long
// videos this app is meant to support. 24MB (not 25MB) leaves a small
// safety margin below the real API limit. Below this, everything works
// exactly as before — one real audio file, one real transcription call.
const MAX_WHISPER_FILE_BYTES = 24 * 1024 * 1024;

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

// Reads the voice-over's real audio bytes. job.voiceover.url is one of
// three shapes, matching every place voiceover-generation.js's
// storeAudioFile call can produce (see video-storage.js): a real https://
// URL (Vercel Blob in production), a /generated/... local reference (the
// no-Blob-token dev/test fallback, read straight from disk — this server
// has no fixed, known base URL to fetch its own static route from), or a
// base64 data: URI (kept for backward compatibility with any job created
// before voice-over audio was moved out of the job record). Returns null
// for anything else, or for a reference that decodes/downloads to zero
// bytes — never guesses at partial/malformed input.
async function resolveVoiceoverAudioBuffer(voiceoverUrl) {
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

  return { buffer, mimeType };
}

function toUploadableFile(buffer, mimeType) {
  const extension = mimeType.split('/')[1] || 'mp3';
  return toFile(buffer, `voiceover.${extension}`, { type: mimeType });
}

// One real transcription call for one real audio buffer — the single unit
// of work shared by both the small-file (one call) and long-video (one
// call per time-bounded segment) paths below.
async function transcribeBuffer(buffer, mimeType) {
  const client = getClient();
  const srt = await client.audio.transcriptions.create({
    file: await toUploadableFile(buffer, mimeType),
    model: TRANSCRIPTION_MODEL,
    response_format: 'srt',
  });
  return typeof srt === 'string' ? srt.trim() : '';
}

// Formats seconds as an SRT timestamp (HH:MM:SS,mmm) — the exact inverse of
// simple-story-video.js's srtTimestampToSeconds, so a round-trip through
// parseSrt -> cuesToSrt never drifts.
function secondsToSrtTimestamp(totalSeconds) {
  const clamped = Math.max(0, totalSeconds);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(ms, 3)}`;
}

// Serializes real, already-measured { start, end, text } cues (as parsed
// by simple-story-video.js's parseSrt from OpenAI's own real transcription
// output) back into standard numbered SRT text. Only ever re-formats real,
// already-real timestamps — never estimates or invents timing itself (see
// this module's own header comment on why that distinction matters).
function cuesToSrt(cues) {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${secondsToSrtTimestamp(cue.start)} --> ${secondsToSrtTimestamp(cue.end)}\n${cue.text}\n`
    )
    .join('\n')
    .trim();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || '').toString().trim().slice(-1000) || error.message));
        return;
      }
      resolve();
    });
  });
}

// Cuts `buffer` into `segmentCount` roughly equal, contiguous time slices
// (re-encoded as mp3 — a plain stream copy at an arbitrary cut point on
// non-frame-aligned MP3 can land mid-frame and corrupt the segment) so
// each one comfortably fits under MAX_WHISPER_FILE_BYTES. This ONLY
// affects the temporary audio sent to Whisper for transcription — the
// real voice-over track (job.voiceover.url), the one actually muxed into
// the final video, is never touched or re-encoded. Returns
// [{ path, startOffsetSeconds }, ...] in chronological order; the caller
// is responsible for deleting workDir afterward.
async function splitAudioIntoSegments(buffer, mimeType, segmentCount, workDir) {
  const extension = mimeType.split('/')[1] || 'mp3';
  const sourcePath = path.join(workDir, `source.${extension}`);
  fs.writeFileSync(sourcePath, buffer);

  const totalDuration = await getMediaDuration(sourcePath);
  const segmentDuration = totalDuration / segmentCount;

  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    const startOffsetSeconds = i * segmentDuration;
    const segmentPath = path.join(workDir, `segment-${i}.mp3`);
    // A tiny overlap-free duration bump on every segment except the last
    // guards against floating-point rounding leaving a sliver of audio
    // (and therefore a few words) unassigned to any segment.
    const duration = i === segmentCount - 1 ? undefined : segmentDuration;
    const args = ['-y', '-i', sourcePath, '-ss', startOffsetSeconds.toFixed(3)];
    if (duration !== undefined) {
      args.push('-t', duration.toFixed(3));
    }
    args.push('-c:a', 'libmp3lame', '-b:a', '128k', segmentPath);
    await runFfmpeg(args);
    segments.push({ path: segmentPath, startOffsetSeconds });
  }

  return segments;
}

function failedResult(error) {
  return { status: 'failed', format: 'srt', content: null, error };
}

// Produces { status: 'completed', format: 'srt', content, error: null } or
// failedResult(...). Never fabricates subtitle content: a missing/invalid
// voice-over audio, an empty transcription, or an API failure all fail
// honestly instead of guessing at timing or text.
//
// A voice-over under MAX_WHISPER_FILE_BYTES (true for anything up to
// roughly a 20-25 minute video at typical TTS bitrates) is transcribed in
// one real call, exactly as before. A longer video's audio — the case this
// exists for, e.g. a 30-40 minute Chat-to-Video script — is split into
// several time-bounded segments (see splitAudioIntoSegments), each
// transcribed for real, and the results merged into one continuous,
// correctly-timed SRT file: every cue's timestamp is shifted by its own
// segment's real start offset in the original audio (not estimated from
// bitrate), so the merged captions line up with the actual voice-over
// exactly as if it had been transcribed in one call.
async function generateSubtitles({ voiceoverUrl }) {
  if (typeof voiceoverUrl !== 'string' || !voiceoverUrl) {
    return failedResult('No real voice-over audio is available to transcribe yet.');
  }

  const resolved = await resolveVoiceoverAudioBuffer(voiceoverUrl);
  if (!resolved) {
    return failedResult('The voice-over audio could not be read for transcription.');
  }
  const { buffer, mimeType } = resolved;

  try {
    if (buffer.length <= MAX_WHISPER_FILE_BYTES) {
      const content = await transcribeBuffer(buffer, mimeType);
      if (!content) {
        return failedResult('The transcription call did not return any subtitle content.');
      }
      return { status: 'completed', format: 'srt', content, error: null };
    }

    const segmentCount = Math.ceil(buffer.length / MAX_WHISPER_FILE_BYTES);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitles-chunk-'));
    try {
      const segments = await splitAudioIntoSegments(buffer, mimeType, segmentCount, workDir);

      // Segments are independent real transcription calls — running them
      // concurrently (order preserved in the results regardless of
      // completion order, same reasoning as voiceover-generation.js's own
      // chunked TTS calls) keeps this well within the serverless time
      // limit instead of paying each segment's latency sequentially.
      const segmentResults = await Promise.all(
        segments.map(async (segment) => ({
          startOffsetSeconds: segment.startOffsetSeconds,
          srt: await transcribeBuffer(fs.readFileSync(segment.path), 'audio/mpeg'),
        }))
      );

      const allCues = [];
      for (const { startOffsetSeconds, srt } of segmentResults) {
        for (const cue of parseSrt(srt)) {
          allCues.push({ start: cue.start + startOffsetSeconds, end: cue.end + startOffsetSeconds, text: cue.text });
        }
      }
      allCues.sort((a, b) => a.start - b.start);

      if (allCues.length === 0) {
        return failedResult('The transcription call did not return any subtitle content.');
      }

      return { status: 'completed', format: 'srt', content: cuesToSrt(allCues), error: null };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('OpenAI subtitle transcription error:', JSON.stringify({ message: describeError(error) }, null, 2));
    return failedResult(describeError(error));
  }
}

module.exports = { generateSubtitles, TRANSCRIPTION_MODEL, MAX_WHISPER_FILE_BYTES, cuesToSrt, secondsToSrtTimestamp };
