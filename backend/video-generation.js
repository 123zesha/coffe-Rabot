// Provider-independent video generation layer. Turns each scene's real
// generated image + motion prompt into a real video clip through three
// stable, provider-agnostic functions — submitVideoGeneration,
// checkVideoGenerationStatus, and retrieveGeneratedVideo — so a real video
// generation API can be plugged in (by adding an entry to PROVIDERS below
// implementing the same three methods) without touching job-store.js,
// server.js's route wiring, or the production stage/confirmation gates.
//
// Registered providers:
//   - `none` — a stub that always reports itself unconfigured. Used
//     whenever VIDEO_GENERATION_PROVIDER isn't set to a real provider name;
//     never returns a fabricated external job ID, clip, or video URL.
//   - `runway` — Runway Gen-4 Turbo (see backend/video-providers/runway.js).
//     Sora is not integrated: its API is deprecated and scheduled to shut
//     down. No other paid provider has been added yet, per current project
//     scope.
//
// Contract every provider must follow: submitVideoGeneration only ever
// returns status 'processing' (accepted, not finished yet) or 'failed' —
// never 'completed'. A real, playable video is only ever established by
// retrieveGeneratedVideo actually returning one; nothing upstream of that
// may be treated as completion.

const RUNWAY_PROVIDER = require('./video-providers/runway');

const NONE_PROVIDER = {
  name: 'none',
  async submitVideoGeneration() {
    return {
      status: 'failed',
      externalJobId: null,
      clips: [],
      error: 'No video generation provider is configured yet.',
    };
  },
  async checkVideoGenerationStatus() {
    return { status: 'failed', clips: [], error: 'No video generation provider is configured yet.' };
  },
  async retrieveGeneratedVideo() {
    return { status: 'failed', url: null, error: 'No video generation provider is configured yet.' };
  },
};

const PROVIDERS = { none: NONE_PROVIDER, runway: RUNWAY_PROVIDER };

// Default clip length/aspect ratio used until a per-video-type shot-planning
// feature (deciding which scenes get real video vs. still+pan/zoom, and
// what duration/ratio fits the video type) is built — that's a separate,
// not-yet-implemented piece of work. For now every scene with a completed
// source image gets one 5-second, 16:9 clip.
const DEFAULT_CLIP_DURATION_SECONDS = 5;
const DEFAULT_ASPECT_RATIO = '16:9';

function getProvider(name) {
  const requested = name || process.env.VIDEO_GENERATION_PROVIDER;
  return (requested && PROVIDERS[requested]) || NONE_PROVIDER;
}

// Submits one scene's image-to-video request. Returns { provider, status,
// externalJobId, clips, error }. status is 'processing' or 'failed'.
async function submitVideoGeneration({ imageDataUri, prompt, durationSeconds, ratio }, provider = getProvider()) {
  const result = await provider.submitVideoGeneration({ imageDataUri, prompt, durationSeconds, ratio });
  return {
    provider: provider.name,
    status: result.status,
    externalJobId: result.externalJobId || null,
    clips: Array.isArray(result.clips) ? result.clips : [],
    error: result.error || null,
  };
}

// Polls the provider for the current state of a previously submitted
// request. Returns { provider, status, clips, error }. status is
// 'processing', 'completed', or 'failed'.
async function checkVideoGenerationStatus({ externalJobId }, provider = getProvider()) {
  const result = await provider.checkVideoGenerationStatus({ externalJobId });
  return {
    provider: provider.name,
    status: result.status,
    clips: Array.isArray(result.clips) ? result.clips : [],
    error: result.error || null,
  };
}

// Retrieves the actual rendered clip once the provider reports it complete.
// Returns { status, url, error }. url is only ever set when status is
// 'completed' — this is the single point where a clip's real, playable URL
// may legitimately be produced.
async function retrieveGeneratedVideo({ externalJobId }, provider = getProvider()) {
  const result = await provider.retrieveGeneratedVideo({ externalJobId });
  return {
    status: result.status,
    url: result.status === 'completed' ? result.url || null : null,
    error: result.error || null,
  };
}

// Runs the submit -> check -> retrieve pipeline for ONE scene, resuming
// from whatever state that scene's clip was already in (retry-safe):
//   - already 'completed'  -> returned unchanged, no provider call at all
//     (never re-submit, never re-charge, for a clip that already succeeded)
//   - 'processing'         -> only polled (check/retrieve), never resubmitted
//     (avoids double-charging a task that's still running)
//   - 'not_started'/'failed' (or no prior state) -> freshly submitted
// `attempts` is incremented exactly once per real submission call, never on
// a pure poll.
async function generateClip({ imageDataUri, prompt, durationSeconds, ratio, existingClip }, provider = getProvider()) {
  const clip = existingClip
    ? { ...existingClip }
    : { status: 'not_started', externalJobId: null, url: null, error: null, attempts: 0 };

  if (clip.status === 'completed') {
    return clip;
  }

  if (clip.status !== 'processing') {
    const submission = await submitVideoGeneration({ imageDataUri, prompt, durationSeconds, ratio }, provider);
    clip.attempts = (clip.attempts || 0) + 1;

    if (submission.status === 'failed') {
      return { ...clip, status: 'failed', externalJobId: null, url: null, error: submission.error };
    }

    clip.externalJobId = submission.externalJobId;
    clip.status = 'processing';
  }

  const statusResult = await checkVideoGenerationStatus({ externalJobId: clip.externalJobId }, provider);

  if (statusResult.status === 'processing') {
    return { ...clip, status: 'processing', url: null, error: null };
  }

  if (statusResult.status !== 'completed') {
    return { ...clip, status: 'failed', url: null, error: statusResult.error || 'Video generation failed.' };
  }

  const retrieved = await retrieveGeneratedVideo({ externalJobId: clip.externalJobId }, provider);

  if (retrieved.status === 'completed' && retrieved.url) {
    return { ...clip, status: 'completed', url: retrieved.url, error: null };
  }

  // The provider claimed 'completed' at the status-check step but retrieval
  // did not actually hand back a playable clip — treat this as a failure,
  // never as a completed clip.
  return { ...clip, status: 'failed', url: null, error: retrieved.error || 'Video retrieval did not return a playable clip.' };
}

// Diagnostic logging for a scene's clip failure, so a real production
// failure (bad promptImage, no Runway credits, invalid/expired API key,
// content-policy rejection, network error, etc.) is visible in server
// logs instead of only sitting silently in job.videoGeneration.clips[i].
// Deliberately logs only scene index, provider name, externalJobId, and
// the error/status text already produced by generateClip/the provider —
// never the request body, headers, or image data, so RUNWAYML_API_SECRET
// (or any other secret) can never end up in this log line.
function logClipFailure(sceneIndex, provider, clip) {
  console.error(
    'Video clip generation failed:',
    JSON.stringify({
      scene: sceneIndex + 1,
      provider: provider.name,
      status: clip.status,
      externalJobId: clip.externalJobId,
      error: clip.error,
    })
  );
}

// Runs generateClip for every scene in order, matching each scene's video
// prompt to its already-generated image by prompt text (the same lookup
// convention image-generation.js's own reference logic uses). Mirrors
// image-generation.js's generateImagesForPrompts: one convenience function
// that loops internally so callers (the /generate-video route) stay thin.
// A scene with no completed source image yet is never sent to the
// provider — it's recorded as a failed clip with a clear reason, never
// silently skipped or fabricated.
async function generateVideoForScenes(
  {
    imagePrompts,
    videoPrompts,
    images,
    existingClips,
    durationSeconds = DEFAULT_CLIP_DURATION_SECONDS,
    ratio = DEFAULT_ASPECT_RATIO,
  },
  provider = getProvider()
) {
  const scenesCount = Array.isArray(videoPrompts) ? videoPrompts.length : 0;
  const clips = [];

  for (let i = 0; i < scenesCount; i++) {
    const prompt = videoPrompts[i];
    const imagePrompt = Array.isArray(imagePrompts) ? imagePrompts[i] : undefined;
    const sourceImage = Array.isArray(images)
      ? images.find((image) => image && image.prompt === imagePrompt && image.status === 'completed')
      : null;
    const existingClip = Array.isArray(existingClips) ? existingClips[i] : null;

    if (!sourceImage) {
      const clip = {
        status: 'failed',
        externalJobId: null,
        url: null,
        error: 'No completed scene image is available to generate a video clip from.',
        attempts: (existingClip && existingClip.attempts) || 0,
      };
      logClipFailure(i, provider, clip);
      clips.push(clip);
      continue;
    }

    const clip = await generateClip(
      { imageDataUri: sourceImage.url, prompt, durationSeconds, ratio, existingClip },
      provider
    );
    if (clip.status === 'failed') {
      logClipFailure(i, provider, clip);
    }
    clips.push(clip);
  }

  return { clips };
}

module.exports = {
  submitVideoGeneration,
  checkVideoGenerationStatus,
  retrieveGeneratedVideo,
  generateClip,
  generateVideoForScenes,
  getProvider,
  PROVIDERS,
  DEFAULT_CLIP_DURATION_SECONDS,
  DEFAULT_ASPECT_RATIO,
};
