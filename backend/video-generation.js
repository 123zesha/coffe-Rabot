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
//
// A provider's retrieveGeneratedVideo URL is not assumed to last forever —
// Runway's own docs confirm its task-output URL (a signed CloudFront/JWT
// link) expires within 24-48 hours of the API call that produced it, even
// though the underlying video stays retrievable through the same task
// (externalJobId) for up to 14 days. So a clip is never left pointing at
// that temporary link: the moment it's retrieved as 'completed', its real
// bytes are downloaded and stored permanently via backend/video-storage.js
// (see ensureClipStored/downloadAndStoreClip below), and `clip.stored`
// records that this has happened. A legacy clip from before this existed,
// or one whose permanent storage somehow became unreachable, is healed
// opportunistically (and for free — a re-fetch of the same completed task,
// never a new paid submission) the next time anything asks for it.

const RUNWAY_PROVIDER = require('./video-providers/runway');
const videoStorage = require('./video-storage');

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
// source image gets one 5-second, 16:9-landscape clip.
const DEFAULT_CLIP_DURATION_SECONDS = 5;
// Runway's image_to_video endpoint, on the API version pinned in
// video-providers/runway.js (2024-11-06), rejects the simplified aspect
// ratio notation "16:9" with a 400 "Validation of body failed" error — as
// of that version, `ratio` must be one of gen4_turbo's literal supported
// output resolutions (landscape: 1280:720, 1584:672, 1104:832; portrait:
// 720:1280, 832:1104; square: 960:960), not a reduced ratio string. This
// is confirmed by Runway's own Node SDK examples, which pass '1280:720'
// for a 16:9 landscape gen4_turbo request. 1280:720 is that literal value.
const DEFAULT_ASPECT_RATIO = '1280:720';

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

// Downloads real bytes from a provider-returned url — a real http(s) link
// (every real provider's actual output) or a data: URI (never produced by
// a real provider today, but handled the same way backend/video-assembly.js
// already does, so a test's fake provider can return one instead of
// standing up a real HTTP server just to exercise this path). Returns null
// rather than throwing on any failure (network error, non-2xx, empty body,
// an unrecognized url shape) — callers treat a null as "this link is no
// good", which is exactly the expired-link case this exists to detect, not
// a bug to crash on.
async function downloadClipBytes(url) {
  if (!url) {
    return null;
  }

  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    const base64 = commaIndex === -1 ? '' : url.slice(commaIndex + 1);
    const buffer = Buffer.from(base64, 'base64');
    return buffer.length > 0 ? buffer : null;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 0 ? buffer : null;
  } catch (error) {
    return null;
  }
}

// Downloads `url` and persists it permanently via video-storage.js,
// returning the new permanent url. Throws (with a clear reason) if either
// step fails — callers decide how that becomes a clip's failed state.
async function downloadAndStoreClip(url, jobId, sceneIndex) {
  const buffer = await downloadClipBytes(url);
  if (!buffer) {
    throw new Error(`Could not download the clip's video from the provider (the link may have expired).`);
  }
  return videoStorage.storeSceneClip(buffer, jobId, sceneIndex);
}

// Ensures a 'completed' clip's url is a REAL, PERMANENTLY-stored reference
// (Vercel Blob or a local file — see video-storage.js), never a provider's
// own temporary output link. A clip already marked `stored: true` is
// trusted completely and returned unchanged — no re-download, no provider
// call, exactly like the original "a completed clip is free to check on
// forever" contract, just now scoped to clips already migrated to
// permanent storage (our own storage doesn't expire the way a provider's
// temporary link does, so there is nothing to re-verify).
//
// A clip that is NOT yet stored — a clip this session just retrieved, or a
// legacy clip from before permanent storage existed — is healed: its
// current url is downloaded once and stored. If that direct download fails
// (the provider's temporary link already expired), falls back to a FREE
// re-fetch of the same completed task via clip.externalJobId
// (checkVideoGenerationStatus + retrieveGeneratedVideo — plain GETs, never
// a new submission) to get a fresh temporary link, then stores that. Only
// when even that isn't possible (task no longer retrievable, no
// externalJobId, etc.) does this return a real 'failed' clip explaining
// that a new, paid regeneration is needed — it never fabricates a url.
//
// A clip that isn't 'completed' is returned completely unchanged — this
// never turns a processing/failed/not_started clip into anything else, and
// never makes a provider call for one.
async function ensureClipStored({ clip, jobId, sceneIndex }, provider = getProvider()) {
  if (!clip || clip.status !== 'completed' || clip.stored) {
    return clip;
  }

  try {
    const url = await downloadAndStoreClip(clip.url, jobId, sceneIndex);
    return { ...clip, url, stored: true, error: null };
  } catch (error) {
    // Fall through to the externalJobId recovery path below.
  }

  if (!clip.externalJobId) {
    return {
      ...clip,
      status: 'failed',
      url: null,
      stored: false,
      error: "This clip's video could not be downloaded and there is no externalJobId to recover it from — it must be regenerated.",
    };
  }

  const statusResult = await checkVideoGenerationStatus({ externalJobId: clip.externalJobId }, provider);
  if (statusResult.status !== 'completed') {
    return {
      ...clip,
      status: 'failed',
      url: null,
      stored: false,
      error: `This clip's stored video is no longer reachable, and the provider no longer reports the original task as completed (status: ${statusResult.status}) — it must be regenerated.`,
    };
  }

  const retrieved = await retrieveGeneratedVideo({ externalJobId: clip.externalJobId }, provider);
  if (retrieved.status !== 'completed' || !retrieved.url) {
    return {
      ...clip,
      status: 'failed',
      url: null,
      stored: false,
      error: retrieved.error || "This clip's video expired and could not be re-fetched from the provider — it must be regenerated.",
    };
  }

  try {
    const url = await downloadAndStoreClip(retrieved.url, jobId, sceneIndex);
    return { ...clip, url, stored: true, error: null };
  } catch (error) {
    return {
      ...clip,
      status: 'failed',
      url: null,
      stored: false,
      error: `The provider re-issued a fresh link for this clip, but it could not be saved permanently: ${error.message}`,
    };
  }
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
async function generateClip(
  { imageDataUri, prompt, durationSeconds, ratio, existingClip, jobId, sceneIndex },
  provider = getProvider()
) {
  const clip = existingClip
    ? { ...existingClip }
    : { status: 'not_started', externalJobId: null, url: null, stored: false, error: null, attempts: 0 };

  if (clip.status === 'completed') {
    return ensureClipStored({ clip, jobId, sceneIndex }, provider);
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
    try {
      // Never store the provider's own temporary link as the lasting
      // reference (see the module comment on why) — download and persist
      // the real bytes immediately, while the link is still fresh.
      const url = await downloadAndStoreClip(retrieved.url, jobId, sceneIndex);
      return { ...clip, status: 'completed', url, stored: true, error: null };
    } catch (error) {
      return {
        ...clip,
        status: 'failed',
        url: null,
        stored: false,
        error: `The clip finished rendering but could not be saved permanently: ${error.message}`,
      };
    }
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
// prompt to its already-generated image by scene position (images[i] for
// videoPrompts[i] — see the positional-matching note further down).
// Mirrors image-generation.js's generateImagesForPrompts: one convenience
// function that loops internally so callers (the /generate-video route)
// stay thin. A scene with no completed source image yet is never sent to
// the provider — it's recorded as a failed clip with a clear reason, never
// silently skipped or fabricated.
//
// `sceneIndex`, when given, restricts this run to that single zero-based
// scene index — every other scene is left completely untouched: no
// provider call, no state change, its existing clip (or an unstarted
// placeholder if it has none yet) is carried through as-is. This lets a
// single, bounded, real test generate Scene 1 only, with Scene 2 (or any
// other scene) structurally guaranteed to never be submitted. Omitting
// sceneIndex (the default) processes every scene, unchanged from the
// original behavior.
async function generateVideoForScenes(
  {
    videoPrompts,
    images,
    existingClips,
    durationSeconds = DEFAULT_CLIP_DURATION_SECONDS,
    ratio = DEFAULT_ASPECT_RATIO,
    sceneIndex = null,
    jobId = null,
  },
  provider = getProvider()
) {
  const scenesCount = Array.isArray(videoPrompts) ? videoPrompts.length : 0;
  const clips = [];

  for (let i = 0; i < scenesCount; i++) {
    const existingClip = Array.isArray(existingClips) ? existingClips[i] : null;

    if (sceneIndex !== null && i !== sceneIndex) {
      clips.push(
        existingClip || { status: 'not_started', externalJobId: null, url: null, stored: false, error: null, attempts: 0 }
      );
      continue;
    }

    const prompt = videoPrompts[i];
    // Scene i's image is images[i] — a positional match, not a text match.
    // image-generation.js's generateImagesForPrompts always rebuilds
    // job.images from job.imagePrompts in the same order on every run, so
    // images[i] is already guaranteed to be the image for imagePrompts[i].
    // Matching by exact prompt-text equality (the previous approach) broke
    // silently the moment imagePrompts[i]'s wording was edited after the
    // image had already been generated — updateVideoJob can rewrite
    // imagePrompts text at any time, but the stored image's .prompt field
    // is frozen at generation time, so any later edit — even a harmless
    // rewording, not a real change of scene — orphaned an already-
    // completed, perfectly usable image from ever being found again.
    const sourceImage = Array.isArray(images) && images[i] && images[i].status === 'completed' ? images[i] : null;

    if (!sourceImage) {
      const clip = {
        status: 'failed',
        externalJobId: null,
        url: null,
        stored: false,
        error: 'No completed scene image is available to generate a video clip from.',
        attempts: (existingClip && existingClip.attempts) || 0,
      };
      logClipFailure(i, provider, clip);
      clips.push(clip);
      continue;
    }

    const clip = await generateClip(
      { imageDataUri: sourceImage.url, prompt, durationSeconds, ratio, existingClip, jobId, sceneIndex: i },
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
  ensureClipStored,
  generateClip,
  generateVideoForScenes,
  getProvider,
  PROVIDERS,
  DEFAULT_CLIP_DURATION_SECONDS,
  DEFAULT_ASPECT_RATIO,
};
