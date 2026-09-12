// Assembles a job's already-generated, real scene video clips (see
// backend/video-generation.js) — plus its voice-over audio, if one has
// already been generated (see backend/voiceover-generation.js) — into one
// real, playable final MP4. Combined with backend/video-storage.js (which
// this module deliberately does NOT depend on — see below), this is the
// ONLY path that may ever set job.finalVideo to 'completed'; nothing else
// may fabricate a value here (see job-store.js's finalVideo comment and the
// READY stage-output gate).
//
// This step calls no paid API at all: every input (clip URLs, voice-over
// audio) was already generated and paid for earlier in the pipeline, and
// combining them is pure local media processing via ffmpeg (bundled through
// the `ffmpeg-static` dependency, so a real ffmpeg binary is available in
// this environment and in a deployed serverless function alike, without
// relying on a system package that Vercel's runtime does not provide).
//
// This module only returns the assembled video's raw bytes — it never
// decides how/where they end up stored. That is deliberately a separate
// concern (backend/video-storage.js): a multi-scene final video can run to
// tens of MB, and embedding that as base64 directly in job.finalVideo.url
// (the way images/voiceover already work) would risk hitting the Redis/
// Upstash per-request payload-size limit — exactly the class of bug fixed
// in job-store.js's per-job-key rework. Keeping ffmpeg processing and
// storage as two separate, independently testable steps means either one
// can change without touching the other. (This module does read
// video-storage.js's GENERATED_DIR constant — see fetchToFile below — but
// only to resolve an INPUT it was already handed, a scene clip whose real
// bytes video-generation.js already stored there; it still never decides
// where the final video it produces gets stored.)
//
// Callers (backend/server.js) are responsible for checking that every scene
// clip is actually 'completed' before calling this — see
// findFinalVideoBlocker — so this module can assume its `clips` input is
// ready to assemble. It still never trusts that blindly: any clip whose
// media can't actually be fetched, or any ffmpeg failure, is reported back
// as a real 'failed' result with the actual error, never silently ignored
// or papered over with fabricated output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const videoStorage = require('./video-storage');

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

// Every scene clip is generated at this fixed size (see
// video-generation.js's DEFAULT_ASPECT_RATIO), but a job's clips could in
// principle differ (a future per-scene aspect ratio, or clips generated
// before that default existed) — ffmpeg's concat filter requires every
// joined segment to share identical dimensions and frame rate, so each clip
// is normalized to this canvas (letterboxed, never cropped or stretched)
// before concatenation rather than assuming they already match.
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const OUTPUT_FPS = 30;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        // ffmpeg's own diagnostic text is on stderr; the last couple KB is
        // almost always enough to show the real cause (bad input, codec
        // mismatch, etc.) without dumping its entire, often-verbose log.
        const detail = (stderr || '').toString().trim().slice(-2000);
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

// Real duration of a media file in seconds, read from ffmpeg's own decode
// log (`-f null -` fully decodes the file with no output written) — never
// trusted from a filename, a requested/expected duration, or any other
// guess. Used to work out how each scene's clip needs to be retimed to
// actually line up with the voice-over (see the sync comment below).
function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      const log = (stderr || '').toString();
      if (error) {
        reject(new Error(`Could not read ${filePath} to determine its duration: ${log.trim().slice(-500)}`));
        return;
      }
      const match = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        reject(new Error(`ffmpeg did not report a duration for ${filePath}.`));
        return;
      }
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (!(seconds > 0)) {
        reject(new Error(`${filePath} has no measurable duration.`));
        return;
      }
      resolve(seconds);
    });
  });
}

// Resolves one clip/audio URL to real bytes on disk at destPath. Supports
// every shape this app's job records actually use: a base64 data: URI
// (voiceover.url), a real http(s) URL (a scene clip stored in Vercel Blob,
// or the final video's own storage in production), a /generated/... local
// reference (a scene clip stored via video-storage.js's no-Blob-token
// dev/test fallback — see video-generation.js's ensureClipStored; resolved
// straight from disk via GENERATED_DIR rather than fetched over HTTP, since
// this server has no fixed, known base URL to fetch its own static route
// from) — plus a plain local filesystem path, which is never produced by a
// real generation call but is what this module's own tests use to exercise
// ffmpeg against real, local sample media with no network or paid API
// involved at all.
async function fetchToFile(url, destPath) {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    const base64 = commaIndex === -1 ? '' : url.slice(commaIndex + 1);
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) {
      throw new Error('data: URI did not decode to any media bytes.');
    }
    fs.writeFileSync(destPath, buffer);
    return;
  }

  if (url.startsWith('/generated/')) {
    const filePath = path.join(videoStorage.GENERATED_DIR, url.slice('/generated/'.length));
    fs.copyFileSync(filePath, destPath);
    return;
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download media (HTTP ${response.status}) from ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error(`Downloaded media from ${url} was empty.`);
    }
    fs.writeFileSync(destPath, buffer);
    return;
  }

  fs.copyFileSync(url, destPath);
}

// clips: job.videoGeneration.clips, already verified by the caller to be
// non-empty and every entry 'completed' with a real url.
// voiceover: job.voiceover — used only when its own status is 'completed'
// and it has a url; any other voiceover state (pending/failed/missing)
// produces a real, playable, video-only final file instead, exactly as
// required — a missing voice-over is never treated as an assembly failure.
//
// Scene sync: the voice-over is one continuous track generated from the
// whole script (backend/voiceover-generation.js) — there is no per-scene
// narration timing to align against without a real speech-alignment/ASR
// call, which would be a new paid API this step must not add. So each
// scene is given an equal share of the voice-over's REAL, measured
// duration (never assumed/guessed) — every scene's own clip is trimmed
// down or extended (by freezing its last frame, never by inventing new
// footage or stretching motion speed) to exactly that share. This
// guarantees the two things "synchronized" actually requires here: the
// full narration is always heard (fixing the old '-shortest' behavior,
// which silently cut off any narration past however long the
// concatenated clips happened to run), and every scene still gets real,
// proportional screen time instead of the final video being paced only by
// arbitrary per-clip lengths. Without a voice-over, clips keep their
// original, unmodified durations — nothing about the video-only path
// changes.
//
// Returns { status: 'completed', buffer: Buffer, error: null } on success —
// buffer is the real assembled MP4's raw bytes, deliberately NOT a url or
// data: URI; see the module comment above for why storage is a separate
// step (backend/video-storage.js) — or { status: 'failed', buffer: null,
// error } on any real failure. Never fabricates a buffer.
async function assembleFinalVideo({ clips, voiceover }) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return { buffer: null, status: 'failed', error: 'No scene video clips were provided to assemble.' };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-assembly-'));

  try {
    const clipPaths = [];
    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(workDir, `clip-${i}.mp4`);
      await fetchToFile(clips[i].url, clipPath);
      clipPaths.push(clipPath);
    }

    const hasVoiceover = Boolean(voiceover && voiceover.status === 'completed' && voiceover.url);
    let audioPath = null;
    let perSceneDuration = null;

    if (hasVoiceover) {
      audioPath = path.join(workDir, 'voiceover-audio');
      await fetchToFile(voiceover.url, audioPath);
      const totalAudioDuration = await getMediaDuration(audioPath);
      perSceneDuration = totalAudioDuration / clipPaths.length;
    }

    const concatenatedPath = path.join(workDir, 'concatenated.mp4');
    const inputArgs = clipPaths.flatMap((clipPath) => ['-i', clipPath]);

    let normalizeFilters;
    if (hasVoiceover) {
      const clipDurations = await Promise.all(clipPaths.map((clipPath) => getMediaDuration(clipPath)));
      normalizeFilters = clipPaths
        .map((_, i) => {
          // trim first to whichever is shorter (a no-op if the clip is
          // already shorter than its share), then tpad makes up any
          // remaining shortfall by holding the last frame — so every
          // normalized clip ends up at EXACTLY perSceneDuration, never
          // over (which would re-introduce the old truncation problem
          // downstream) and never under (dead air with no picture).
          const trimTo = Math.min(clipDurations[i], perSceneDuration).toFixed(3);
          const padBy = Math.max(0, perSceneDuration - clipDurations[i]).toFixed(3);
          // Deliberately no setpts=PTS-STARTPTS between trim and tpad: it
          // resets each frame's timestamp to start at 0, which — verified
          // empirically against this exact ffmpeg build — makes tpad
          // compute its stop_duration padding against the wrong timeline
          // and silently pad far less than requested. concat (below)
          // already normalizes timestamps across segments on its own, so
          // no reset is needed here.
          return (
            `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS},` +
            `trim=duration=${trimTo},` +
            `tpad=stop_mode=clone:stop_duration=${padBy}[v${i}]`
          );
        })
        .join(';');
    } else {
      normalizeFilters = clipPaths
        .map(
          (_, i) =>
            `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS}[v${i}]`
        )
        .join(';');
    }

    const concatRefs = clipPaths.map((_, i) => `[v${i}]`).join('');
    const filterComplex = `${normalizeFilters};${concatRefs}concat=n=${clipPaths.length}:v=1:a=0[outv]`;

    await runFfmpeg([
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[outv]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      concatenatedPath,
    ]);

    let finalPath = concatenatedPath;

    if (hasVoiceover) {
      finalPath = path.join(workDir, 'final.mp4');
      // The concatenated video's total length is now (perSceneDuration *
      // scene count), which already equals the voice-over's real duration
      // to within float/frame rounding — -shortest here is only a safety
      // net for that rounding, not the primary sync mechanism anymore.
      await runFfmpeg([
        '-y',
        '-i',
        concatenatedPath,
        '-i',
        audioPath,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        finalPath,
      ]);
    }

    const buffer = fs.readFileSync(finalPath);
    if (buffer.length === 0) {
      throw new Error('ffmpeg produced an empty output file.');
    }

    return { buffer, status: 'completed', error: null };
  } catch (error) {
    const message = (error && error.message) || 'Unknown error assembling final video.';
    console.error('Final video assembly error:', JSON.stringify({ message }, null, 2));
    return { buffer: null, status: 'failed', error: message };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { assembleFinalVideo, getMediaDuration, ffmpegPath };
