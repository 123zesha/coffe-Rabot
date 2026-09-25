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
const { OUTPUT_FORMATS, DEFAULT_OUTPUT_FORMAT, DEFAULT_RESOLUTION_TIER } = require('./job-store');

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

// Every scene clip is generated at the job's own outputFormat (see
// video-generation.js's ASPECT_RATIO_BY_FORMAT), but a job's clips could in
// principle differ (clips generated before output-format support existed,
// or — in the rare in-flight-request race documented in
// video-generation.js's generateClip — a clip whose request predates a
// since-changed format) — ffmpeg's concat filter requires every joined
// segment to share identical dimensions and frame rate, so each clip is
// normalized to this canvas (letterboxed, never cropped or stretched)
// before concatenation rather than assuming they already match. The
// canvas itself matches Runway's own literal output dimensions for the
// job's outputFormat, so normalizing is a no-op scale/pad in the common
// case (every clip already exactly this size) — never resized down or
// degraded to fit.
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;

// resolutionTier is a FINAL-ASSEMBLY-ONLY setting (see job-store.js's own
// comment on RESOLUTION_TIERS) — every clip is still generated at its
// job's outputFormat canvas below regardless of tier, so this table only
// changes what the last scale/pad/concat pass upscales that same source
// footage to. 1080p/4K are exact 1.5x/3x linear multiples of the 720p
// canvas for each format, preserving the identical aspect ratio at every
// tier. '4k' in particular is a real, honest upscale of 720p-equivalent
// source material — the exported file's pixel dimensions genuinely match
// 3840x2160, but that is not the same as native 4K-captured detail (see
// prompts/system-prompt.md's Video Resolution section for how this must be
// communicated to the user).
const OUTPUT_DIMENSIONS_BY_FORMAT_AND_TIER = {
  horizontal: { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] },
  vertical: { '720p': [720, 1280], '1080p': [1080, 1920], '4k': [2160, 3840] },
  square: { '720p': [960, 960], '1080p': [1080, 1080], '4k': [2160, 2160] },
};

// Kept as the plain format -> 720p-tier dimensions map — this is exactly
// today's pre-existing shape/values, still used wherever only the default
// tier matters (e.g. this module's own tests).
const OUTPUT_DIMENSIONS_BY_FORMAT = Object.fromEntries(
  Object.entries(OUTPUT_DIMENSIONS_BY_FORMAT_AND_TIER).map(([format, tiers]) => [format, tiers[DEFAULT_RESOLUTION_TIER]])
);

function resolveOutputDimensions(outputFormat, resolutionTier) {
  const tiers = OUTPUT_DIMENSIONS_BY_FORMAT_AND_TIER[outputFormat] || OUTPUT_DIMENSIONS_BY_FORMAT_AND_TIER[DEFAULT_OUTPUT_FORMAT];
  return tiers[resolutionTier] || tiers[DEFAULT_RESOLUTION_TIER];
}

const OUTPUT_FPS = 30;

// Background music constants (see the musicUrl branch in assembleFinalVideo
// below). Music is looped/trimmed to the final video's own real duration,
// faded in/out, and — when a voice-over exists — quietly ducked under it
// rather than mixed at a flat level, so narration always stays clearly
// audible.
const MUSIC_FADE_SECONDS = 2;
// Baseline linear volume multiplier applied to music BEFORE ducking, only
// used when a voice-over exists — deliberately quiet up front (ffmpeg's
// sidechaincompress then only has to duck it further during actual speech,
// rather than doing all the attenuation work itself).
const MUSIC_VOLUME_WITH_VOICEOVER = 0.35;
// Music-only (no voice-over to protect) plays at a fuller, standalone
// background level.
const MUSIC_VOLUME_SOLO = 0.8;
// sidechaincompress parameters: how hard/fast music ducks under the
// voice-over's envelope. A low threshold + high ratio means even normal
// speech volume triggers strong ducking; a short attack and a longer
// release avoid audibly chopping music on/off between words.
const MUSIC_DUCK_THRESHOLD = 0.05;
const MUSIC_DUCK_RATIO = 8;
const MUSIC_DUCK_ATTACK_MS = 5;
const MUSIC_DUCK_RELEASE_MS = 300;

// Loops/trims musicPath to exactly targetDurationSeconds, applies `volume`,
// and adds a short fade-in/out (clamped so a fade never exceeds half the
// target duration, which matters for a very short target). `-stream_loop -1`
// re-reads the input as many times as needed, so this handles a track
// shorter OR longer than the target with the same call — no separate
// loop-vs-trim branch needed. Throws (via runFfmpeg) with ffmpeg's own real
// error on a missing/corrupt music file — never silently skipped.
async function prepareMusicTrack(musicPath, targetDurationSeconds, volume, outPath) {
  const fadeSeconds = Math.max(0.05, Math.min(MUSIC_FADE_SECONDS, targetDurationSeconds / 2));
  const fadeOutStart = Math.max(0, targetDurationSeconds - fadeSeconds);

  await runFfmpeg([
    '-y',
    '-stream_loop',
    '-1',
    '-i',
    musicPath,
    '-t',
    targetDurationSeconds.toFixed(3),
    '-af',
    `volume=${volume},afade=t=in:st=0:d=${fadeSeconds.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSeconds.toFixed(3)}`,
    '-c:a',
    'aac',
    outPath,
  ]);
}

// Ducks preparedMusicPath under voiceoverPath's own envelope (sidechaincompress)
// and mixes the two into one audio track at outPath. `normalize=0` on amix is
// deliberate: ffmpeg's default auto-normalize would also quiet down the
// voice-over to keep the sum from clipping, which is exactly what "voice-over
// must remain clearly audible" rules out — music is already attenuated/ducked
// enough on its own that the voice-over can be mixed in at its own full level.
async function duckAndMixMusicWithVoiceover(preparedMusicPath, voiceoverPath, outPath) {
  const filterComplex =
    `[0:a][1:a]sidechaincompress=threshold=${MUSIC_DUCK_THRESHOLD}:ratio=${MUSIC_DUCK_RATIO}:` +
    `attack=${MUSIC_DUCK_ATTACK_MS}:release=${MUSIC_DUCK_RELEASE_MS}[duckedmusic];` +
    `[duckedmusic][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixedaudio]`;

  await runFfmpeg([
    '-y',
    '-i',
    preparedMusicPath,
    '-i',
    voiceoverPath,
    '-filter_complex',
    filterComplex,
    '-map',
    '[mixedaudio]',
    '-c:a',
    'aac',
    outPath,
  ]);
}

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

// Which stream types ffmpeg's own decode log reports for filePath — read
// the same way getMediaDuration reads duration (ffmpeg's own stderr, never
// trusted from a filename/container extension). Used only to verify an
// assembled output actually contains what it should before reporting a
// job "completed" — see verifyAssembledVideoBuffer below.
function probeStreamTypes(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      // `ffmpeg -i <file>` with no output always exits non-zero (nothing was
      // asked to be produced), but it still prints the real stream list to
      // stderr first — same reasoning as getMediaDuration ignoring `error`.
      const log = (stderr || '').toString();
      resolve({
        hasVideoStream: /Stream #\d+:\d+.*: Video:/.test(log),
        hasAudioStream: /Stream #\d+:\d+.*: Audio:/.test(log),
      });
    });
  });
}

// Verifies a just-assembled final video's real bytes before the caller
// reports finalVideo as 'completed' — ffmpeg's own encode/mux step exiting
// without error is not, by itself, proof the output is a real, complete,
// playable video (a truncated mux or a dropped stream can still exit 0).
// Checks the actual decoded file for: non-empty bytes, a readable/
// measurable duration, a video stream, an audio stream (only when the
// caller says one should exist — a silent/no-voice-over video legitimately
// has none), and — when the caller gives minDurationSeconds (the real
// narration audio's own measured length) — that the output isn't
// drastically shorter than the audio it was supposed to fully cover
// (allows minor rounding/fade overlap, not a silently truncated render).
// Returns { ok: true, durationSeconds } or { ok: false, reason }; never
// throws — a verification failure is reported the same honest way as any
// other assembly failure.
//
// The shortfall allowed is the LARGER of a relative 10% and this fixed
// absolute floor (i.e. the effective threshold is the MIN of the two
// thresholds this produces) — a pure 10% margin is too tight for short
// clips: AAC encoder priming, sidechaincompress lookahead and the music
// fade in prepareMusicTrack above all cost a roughly constant amount of
// real time, which is a large fraction of a 1-3s test fixture but
// negligible next to a real 30s-40min video. This is the same ±0.5s this
// file's own duration assertions already use (see the sync tests above).
const MIN_DURATION_ABSOLUTE_TOLERANCE_SECONDS = 0.5;

async function verifyAssembledVideoBuffer(buffer, { expectAudioStream = false, minDurationSeconds } = {}) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: 'the assembled video file is empty' };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-video-'));
  const filePath = path.join(workDir, 'output.mp4');
  try {
    fs.writeFileSync(filePath, buffer);

    let durationSeconds;
    try {
      durationSeconds = await getMediaDuration(filePath);
    } catch (error) {
      return { ok: false, reason: `the assembled video could not be read back (${error.message})` };
    }

    if (typeof minDurationSeconds === 'number' && minDurationSeconds > 0) {
      const relativeThreshold = minDurationSeconds * 0.9;
      const absoluteThreshold = Math.max(0, minDurationSeconds - MIN_DURATION_ABSOLUTE_TOLERANCE_SECONDS);
      const threshold = Math.min(relativeThreshold, absoluteThreshold);
      if (durationSeconds < threshold) {
        return {
          ok: false,
          reason:
            `the assembled video's real duration (${durationSeconds.toFixed(1)}s) is well short of the ` +
            `narration audio it should cover (${minDurationSeconds.toFixed(1)}s)`,
        };
      }
    }

    const { hasVideoStream, hasAudioStream } = await probeStreamTypes(filePath);
    if (!hasVideoStream) {
      return { ok: false, reason: 'the assembled file has no readable video stream' };
    }
    if (expectAudioStream && !hasAudioStream) {
      return { ok: false, reason: 'the assembled video is missing its expected audio track' };
    }

    return { ok: true, durationSeconds };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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
// burnInSubtitlesContent: optional real .srt file text (backend/
// subtitles-generation.js's own output — the caller in server.js is
// responsible for only ever passing real, completed subtitle content,
// never inventing any). When omitted/null, the output is byte-for-byte
// identical to what this function has always produced — this parameter
// only ever ADDS one more ffmpeg filter step, never changes any existing
// behavior. When provided, it is written to a real .srt file and burned
// into the video via ffmpeg's own `subtitles` filter, applied AFTER the
// scale/pad/trim/concat steps below so captions are rendered onto the
// final, already-composed frame — never mid-normalization, where per-clip
// coordinates wouldn't line up with the concatenated timeline.
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
// musicUrl: optional, resolved by the caller (backend/music-library.js) from
// the job's musicEnabled/musicTrack/musicCustomUrl settings — a data: URI,
// http(s) URL, /generated/ reference, or local path, same shapes fetchToFile
// already handles for clips/voiceover. Omitted/null (the default — music is
// off unless a job explicitly enables it) leaves every existing code path
// byte-for-byte unchanged, exactly like burnInSubtitlesContent above. When
// provided, it is looped/trimmed to the final video's own real duration,
// faded in/out, and mixed in — quietly ducked under the voice-over via
// sidechaincompress if one exists, or played at a fuller standalone level if
// there is no voice-over to protect. A missing or corrupt music file fails
// this call clearly (a real ffmpeg/fetch error), never silently ignored.
//
// resolutionTier: optional, one of job-store.js's RESOLUTION_TIERS
// ('720p'/'1080p'/'4k'). Omitted/null defaults to '720p' — the exact
// pre-existing pixel dimensions for outputFormat, unchanged. A higher tier
// only changes the target canvas the scale/pad stage below upscales the
// SAME source clips to (via a lanczos scale, for a materially better
// upscale than the default bilinear) — it never requests larger source
// footage from any provider. The returned buffer's real, decoded
// dimensions always match the resolved tier exactly (verified by this
// module's own tests via a real ffmpeg decode, never merely assumed).
//
// Returns { status: 'completed', buffer: Buffer, error: null } on success —
// buffer is the real assembled MP4's raw bytes, deliberately NOT a url or
// data: URI; see the module comment above for why storage is a separate
// step (backend/video-storage.js) — or { status: 'failed', buffer: null,
// error } on any real failure. Never fabricates a buffer.
async function assembleFinalVideo({ clips, voiceover, burnInSubtitlesContent, outputFormat, musicUrl, resolutionTier }) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return { buffer: null, status: 'failed', error: 'No scene video clips were provided to assemble.' };
  }

  const [outputWidth, outputHeight] = resolveOutputDimensions(outputFormat, resolutionTier);
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
    let totalAudioDuration = null;

    if (hasVoiceover) {
      audioPath = path.join(workDir, 'voiceover-audio');
      await fetchToFile(voiceover.url, audioPath);
      totalAudioDuration = await getMediaDuration(audioPath);
      perSceneDuration = totalAudioDuration / clipPaths.length;
    }

    // Fetched up front (before any concat/ffmpeg work) so a missing/corrupt
    // music file is reported clearly and immediately, same as a bad clip
    // url above — never silently skipped or discovered only after the rest
    // of assembly already ran.
    let musicSourcePath = null;
    if (musicUrl) {
      musicSourcePath = path.join(workDir, 'music-input');
      await fetchToFile(musicUrl, musicSourcePath);
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
            `[${i}:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease:flags=lanczos,` +
            `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS},` +
            `trim=duration=${trimTo},` +
            `tpad=stop_mode=clone:stop_duration=${padBy}[v${i}]`
          );
        })
        .join(';');
    } else {
      normalizeFilters = clipPaths
        .map(
          (_, i) =>
            `[${i}:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease:flags=lanczos,` +
            `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS}[v${i}]`
        )
        .join(';');
    }

    // Burning in subtitles is an ADDITIONAL filter stage applied to the
    // concat output, never a change to the normalize/concat stages above —
    // when burnInSubtitlesContent is omitted, concatOutputLabel stays
    // 'outv' and subtitlesStage stays '', making filterComplex byte-for-
    // byte identical to the pre-existing behavior. The .srt file is written
    // into this same call's own workDir (removed with it afterward), and
    // ffmpeg's subtitles filter is applied after concatenation so captions
    // are burned onto the final, already-composed frame/timeline — never
    // per-clip, before concat has established the real final timing.
    let concatOutputLabel = 'outv';
    let srtPath = null;
    if (burnInSubtitlesContent) {
      srtPath = path.join(workDir, 'captions.srt');
      fs.writeFileSync(srtPath, burnInSubtitlesContent, 'utf8');
      concatOutputLabel = 'concatv';
    }

    const concatRefs = clipPaths.map((_, i) => `[v${i}]`).join('');
    const subtitlesStage = srtPath ? `;[${concatOutputLabel}]subtitles=${srtPath}[outv]` : '';
    const filterComplex =
      `${normalizeFilters};${concatRefs}concat=n=${clipPaths.length}:v=1:a=0[${concatOutputLabel}]` + subtitlesStage;

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
    // The single audio track that ends up muxed with the video below — the
    // voice-over alone (pre-existing behavior, unchanged when musicUrl is
    // omitted), the prepared music track alone (no voice-over to protect),
    // or the two ducked/mixed together. Stays null (video-only output,
    // exactly as before) when neither exists.
    let audioForMuxPath = hasVoiceover ? audioPath : null;

    if (musicSourcePath) {
      // Music must match the SAME final duration the video ends up at: the
      // voice-over's real duration when one exists (the video was already
      // retimed to match it above), or the concatenated video's own real
      // duration otherwise.
      const musicTargetDuration = hasVoiceover ? totalAudioDuration : await getMediaDuration(concatenatedPath);
      const preparedMusicPath = path.join(workDir, 'music-prepared.m4a');
      await prepareMusicTrack(
        musicSourcePath,
        musicTargetDuration,
        hasVoiceover ? MUSIC_VOLUME_WITH_VOICEOVER : MUSIC_VOLUME_SOLO,
        preparedMusicPath
      );

      if (hasVoiceover) {
        const mixedAudioPath = path.join(workDir, 'audio-mixed.m4a');
        await duckAndMixMusicWithVoiceover(preparedMusicPath, audioPath, mixedAudioPath);
        audioForMuxPath = mixedAudioPath;
      } else {
        audioForMuxPath = preparedMusicPath;
      }
    }

    if (audioForMuxPath) {
      finalPath = path.join(workDir, 'final.mp4');
      // The concatenated video's total length is now (perSceneDuration *
      // scene count) when there's a voice-over, which already equals its
      // real duration to within float/frame rounding — -shortest here is
      // only a safety net for that rounding (and, for music prepared
      // above, for the same reason), not the primary sync mechanism.
      await runFfmpeg([
        '-y',
        '-i',
        concatenatedPath,
        '-i',
        audioForMuxPath,
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

    // Verify before reporting success — ffmpeg's own exit code is not, by
    // itself, proof the output is a real, complete, playable video (a
    // truncated mux or a dropped stream can still exit 0). expectAudioStream
    // only when this specific assembly actually included one (hasVoiceover,
    // or a solo music track) — a genuinely silent, voice-over-less,
    // music-less video legitimately has no audio stream, and that must not
    // be reported as a failure.
    const verification = await verifyAssembledVideoBuffer(buffer, {
      expectAudioStream: Boolean(audioForMuxPath),
      minDurationSeconds: hasVoiceover ? totalAudioDuration : null,
    });
    if (!verification.ok) {
      const message = `Assembly finished but failed verification: ${verification.reason}`;
      console.error('Final video assembly error:', JSON.stringify({ message }, null, 2));
      return { buffer: null, status: 'failed', error: message };
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

// Extracts one real frame from an ALREADY-assembled final video as a PNG —
// the only thumbnail source a 'simple-story' job is allowed to use (see
// server.js's runGenerateYoutubePackage): that mode never calls Runway or
// any image-generation API, so its thumbnail comes from local ffmpeg
// instead of a paid OpenAI image call, exactly like every other asset it
// produces. atSeconds is clamped to the real decoded duration (via
// getMediaDuration) so a clip shorter than the requested offset still
// yields a real frame instead of ffmpeg seeking past the end and failing.
// Throws with ffmpeg's own error on a missing/corrupt video — never
// fabricates a frame.
async function extractThumbnailFrame(videoUrl, { atSeconds = 2 } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-frame-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'frame.png');
  try {
    await fetchToFile(videoUrl, inputPath);
    const durationSeconds = await getMediaDuration(inputPath);
    const seekSeconds = Math.max(0, Math.min(atSeconds, durationSeconds - 0.1));
    await runFfmpeg(['-y', '-ss', seekSeconds.toFixed(3), '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath]);
    const buffer = fs.readFileSync(outputPath);
    if (buffer.length === 0) {
      throw new Error('ffmpeg produced an empty thumbnail frame.');
    }
    return buffer;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Real duration of an ALREADY-generated media file (e.g. a job's voice-over
// audio), given only its stored url — resolves every url shape this app's
// job records actually use (data:, /generated/, http(s), a plain local
// path — see fetchToFile above) to real bytes, then decodes them locally
// with getMediaDuration. Purely local ffmpeg work, zero paid API cost —
// used by server.js right after a real (paid) voice-over generation to get
// an honest, measured duration for the production cost estimate, rather
// than the rougher script-length guess used before any audio exists.
// Throws on a missing/corrupt file — callers treat this as best-effort and
// never let a failure here undo an already-successful, already-paid
// generation.
async function getUrlMediaDurationSeconds(url) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-duration-'));
  const filePath = path.join(workDir, 'input');
  try {
    await fetchToFile(url, filePath);
    return await getMediaDuration(filePath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  assembleFinalVideo,
  getMediaDuration,
  getUrlMediaDurationSeconds,
  verifyAssembledVideoBuffer,
  extractThumbnailFrame,
  // Exported so backend/simple-story-video.js's own final assembly step can
  // mix in background music using the EXACT same local-ffmpeg logic as this
  // module's own Runway pipeline (loop/trim/fade, then duck under the
  // voice-over) — one real implementation of "mix music under narration",
  // never a second copy of the same ffmpeg filter chain.
  prepareMusicTrack,
  duckAndMixMusicWithVoiceover,
  MUSIC_VOLUME_WITH_VOICEOVER,
  ffmpegPath,
  OUTPUT_DIMENSIONS_BY_FORMAT,
  OUTPUT_DIMENSIONS_BY_FORMAT_AND_TIER,
};
