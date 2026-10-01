// Estimates the real paid-API cost of producing a video job — informational
// only, never a guaranteed bill. Every per-unit rate below is an
// approximate, illustrative figure for this app's own configured models
// (voiceover-generation.js's TTS_MODEL, subtitles-generation.js's
// TRANSCRIPTION_MODEL, image-generation.js's IMAGE_MODEL,
// youtube-package.js's PACKAGE_MODEL) — real provider pricing changes over
// time and the provider's own invoice is always the source of truth, never
// this estimate. Pure, deterministic, and makes no network/API call of its
// own, so computing (or re-computing) an estimate never costs anything.

// ~150 words/minute average narration pace at ~6 characters/word (5 letters
// + 1 space) — a common estimate for spoken-English pacing, used only when
// no real, measured voice-over duration exists yet.
const AVG_CHARACTERS_PER_SPOKEN_MINUTE = 900;

const TTS_ESTIMATED_USD_PER_1K_CHARACTERS = 0.015;
const TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE = 0.006;
// One medium-quality, single 16:9 image — see image-generation.js's
// IMAGE_QUALITY/IMAGE_SIZE. Only applies to a 'cinematic' job's thumbnail;
// 'simple-story' thumbnails are a free local ffmpeg frame extraction (see
// server.js's runGenerateYoutubePackage).
const THUMBNAIL_IMAGE_ESTIMATED_USD = 0.07;
// One 'simple-story' background illustration (see image-generation.js's
// generateBackgroundImage / server.js's POST /:id/generate-background-image)
// — the SAME per-image rate as THUMBNAIL_IMAGE_ESTIMATED_USD (same model/
// quality/size), kept as its own named constant since it's conceptually a
// different feature. Applies once per job, regardless of the video's
// length, since only ONE illustration is ever generated per job — never
// per section. Uploading your own image, or using no image at all, is
// always free; this only applies when the user chose "Generate with AI".
const BACKGROUND_IMAGE_ESTIMATED_USD = 0.07;
// One short Claude call producing titles/description/tags/thumbnail
// concept from an already-finished script.
const YOUTUBE_PACKAGE_TEXT_ESTIMATED_USD = 0.02;
// "Upload & Compile" per-clip AI voice-over (see backend/clip-voiceover.js):
// one short Claude vision call describing the clip's own frame, plus one
// short TTS synthesis of the resulting narration line. The real narration
// text doesn't exist yet at estimate time, so its length is assumed at
// ASSUMED_CLIP_NARRATION_CHARACTERS — comfortably covers a natural, concise
// one-to-two-sentence narration line, never a full script — and the TTS
// portion reuses TTS_ESTIMATED_USD_PER_1K_CHARACTERS above so both stay
// consistent with each other automatically.
const CLIP_VISION_DESCRIPTION_ESTIMATED_USD = 0.01;
const ASSUMED_CLIP_NARRATION_CHARACTERS = 150;

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function estimateSpeechDurationSeconds(scriptLength) {
  return (scriptLength / AVG_CHARACTERS_PER_SPOKEN_MINUTE) * 60;
}

// realVoiceoverDurationSeconds, when given (a real, measured value — see
// video-assembly.js's getUrlMediaDurationSeconds), only sharpens the
// subtitles/transcription estimate, which bills on real audio minutes; the
// voiceover estimate itself is always driven by the script's own character
// count, since that's what text-to-speech actually bills on.
// voiceSource: 'ai' (default) or 'upload' — "Upload My Own Voice" (see
// server.js's POST /:id/upload-voiceover) skips paid TTS entirely, so its
// voiceover cost is always zero; subtitles/transcription still costs real
// money either way, since Whisper transcribes whichever real audio exists
// (generated or uploaded) to produce synchronized subtitles.
// generateBackgroundImage: whether this 'simple-story' job's background
// illustration is (or will be) AI-generated, set once at job creation from
// the user's own "Generate with AI" choice (see server.js's POST
// /api/jobs/story-to-video and job-store.js's generateBackgroundImage
// field) — never inferred from whether videoEditSettings.backgroundImage
// happens to be set, since an UPLOADED image also sets that field but costs
// nothing. Defaults to false/falsy, so any job that never touches this
// feature (every job created before it existed, and any 'cinematic' job)
// shows exactly the same total this function already produced.
function estimateProductionCost({
  script,
  videoMode,
  generateYoutubePackage,
  realVoiceoverDurationSeconds,
  voiceSource,
  generateBackgroundImage,
} = {}) {
  const scriptLength = typeof script === 'string' ? script.trim().length : 0;
  const hasRealDuration = typeof realVoiceoverDurationSeconds === 'number' && realVoiceoverDurationSeconds > 0;
  const estimatedDurationSeconds = hasRealDuration ? realVoiceoverDurationSeconds : estimateSpeechDurationSeconds(scriptLength);
  const estimatedMinutes = estimatedDurationSeconds / 60;
  const usesUploadedVoice = voiceSource === 'upload';

  const breakdown = {
    voiceover: scriptLength > 0 && !usesUploadedVoice ? round4((scriptLength / 1000) * TTS_ESTIMATED_USD_PER_1K_CHARACTERS) : 0,
    subtitles: scriptLength > 0 || hasRealDuration ? round4(estimatedMinutes * TRANSCRIPTION_ESTIMATED_USD_PER_MINUTE) : 0,
    thumbnail: generateYoutubePackage ? (videoMode === 'simple-story' ? 0 : THUMBNAIL_IMAGE_ESTIMATED_USD) : 0,
    backgroundImage: generateBackgroundImage ? BACKGROUND_IMAGE_ESTIMATED_USD : 0,
    youtubePackageText: generateYoutubePackage ? YOUTUBE_PACKAGE_TEXT_ESTIMATED_USD : 0,
  };

  const totalUsd = round4(Object.values(breakdown).reduce((sum, value) => sum + value, 0));

  return {
    totalUsd,
    breakdown,
    estimatedDurationSeconds: Math.round(estimatedDurationSeconds * 10) / 10,
    basis: hasRealDuration ? 'measured-voiceover' : 'script-length',
    note: 'Estimate only, using approximate per-unit provider rates — the actual bill may differ.',
  };
}

// Cost for generating AI voice-overs for `selectedClipCount` clips in the
// "Upload & Compile" flow (see backend/clip-voiceover.js) — reducing real
// spend to exactly the clips the user explicitly selects, never every
// uploaded clip. Pure, deterministic, no network call, like
// estimateProductionCost above.
function estimateClipVoiceoverCost(selectedClipCount) {
  const clipCount = Math.max(0, Math.round(Number(selectedClipCount) || 0));
  const perClipUsd = round4(
    CLIP_VISION_DESCRIPTION_ESTIMATED_USD + (ASSUMED_CLIP_NARRATION_CHARACTERS / 1000) * TTS_ESTIMATED_USD_PER_1K_CHARACTERS
  );

  return {
    clipCount,
    perClipUsd,
    totalUsd: round4(perClipUsd * clipCount),
    note:
      'Estimate only — assumes a short, natural one-to-two-sentence narration line per clip; the actual ' +
      'bill depends on the real generated narration length.',
  };
}

module.exports = { estimateProductionCost, estimateSpeechDurationSeconds, estimateClipVoiceoverCost };
