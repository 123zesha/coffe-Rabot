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
// One short Claude call producing titles/description/tags/thumbnail
// concept from an already-finished script.
const YOUTUBE_PACKAGE_TEXT_ESTIMATED_USD = 0.02;

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
function estimateProductionCost({
  script,
  videoMode,
  generateYoutubePackage,
  realVoiceoverDurationSeconds,
  voiceSource,
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

module.exports = { estimateProductionCost, estimateSpeechDurationSeconds };
