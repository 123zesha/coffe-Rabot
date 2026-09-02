// Provider-independent video generation layer. Turns a job's scenes/video
// prompts into a real, rendered MP4 through three stable, provider-agnostic
// functions — submitVideoGeneration, checkVideoGenerationStatus, and
// retrieveGeneratedVideo — so a real video generation API can be plugged in
// later (by adding an entry to PROVIDERS below implementing the same three
// methods) without touching job-store.js, server.js's route wiring, or the
// production stage/confirmation gates at all.
//
// No paid video generation provider is registered yet:
//   - Sora is not integrated: its API is deprecated and scheduled to shut
//     down.
//   - No other paid provider has been added yet, per current project scope.
//
// The only registered provider is `none`, a stub that always reports itself
// unconfigured. It never returns a fabricated external job ID, clip, or
// video URL — this proves the full submit -> check -> retrieve pipeline
// end-to-end (including job-store persistence and the COMPLETED gate) with
// zero risk of ever claiming a fake video was produced.
//
// Contract every provider must follow: submitVideoGeneration only ever
// returns status 'processing' (accepted, not finished yet) or 'failed' —
// never 'completed'. A real, playable video is only ever established by
// retrieveGeneratedVideo actually returning one; nothing upstream of that
// may be treated as completion.

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

const PROVIDERS = { none: NONE_PROVIDER };

function getProvider(name) {
  const requested = name || process.env.VIDEO_GENERATION_PROVIDER;
  return (requested && PROVIDERS[requested]) || NONE_PROVIDER;
}

// Submits a video generation request. Returns { provider, status,
// externalJobId, clips, error }. status is 'processing' or 'failed'.
async function submitVideoGeneration({ videoPrompts, scenes, characters }, provider = getProvider()) {
  const result = await provider.submitVideoGeneration({ videoPrompts, scenes, characters });
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

// Retrieves the actual rendered video once the provider reports it
// complete. Returns { status, url, error }. url is only ever set when
// status is 'completed' — this is the single point where a finalVideo may
// legitimately be produced.
async function retrieveGeneratedVideo({ externalJobId }, provider = getProvider()) {
  const result = await provider.retrieveGeneratedVideo({ externalJobId });
  return {
    status: result.status,
    url: result.status === 'completed' ? result.url || null : null,
    error: result.error || null,
  };
}

// Runs the full submit -> check -> retrieve pipeline once, for the
// /generate-video route. Returns { videoGeneration, finalVideo? }.
// finalVideo is only ever included when retrieveGeneratedVideo itself
// reports a real, completed, playable URL — never inferred or guessed from
// an earlier step. A 'processing' result from submit or check simply stops
// here without fabricating anything further; a real asynchronous provider
// is expected to be re-checked by calling this again later (the same
// pattern this project already uses for image/voice-over generation, where
// the caller re-invokes the route to retry).
async function generateVideo({ videoPrompts, scenes, characters }, provider = getProvider()) {
  const submission = await submitVideoGeneration({ videoPrompts, scenes, characters }, provider);

  const videoGeneration = {
    provider: submission.provider,
    status: submission.status,
    externalJobId: submission.externalJobId,
    clips: submission.clips,
    error: submission.error,
  };

  if (submission.status !== 'processing') {
    return { videoGeneration };
  }

  const statusResult = await checkVideoGenerationStatus({ externalJobId: submission.externalJobId }, provider);
  videoGeneration.status = statusResult.status;
  if (statusResult.clips.length > 0) {
    videoGeneration.clips = statusResult.clips;
  }
  videoGeneration.error = statusResult.error;

  if (statusResult.status !== 'completed') {
    return { videoGeneration };
  }

  const retrieved = await retrieveGeneratedVideo({ externalJobId: submission.externalJobId }, provider);

  if (retrieved.status === 'completed' && retrieved.url) {
    return { videoGeneration, finalVideo: { url: retrieved.url, status: 'completed' } };
  }

  // The provider claimed 'completed' at the status-check step but retrieval
  // did not actually hand back a playable video — treat this as a failure,
  // never as a completed job.
  videoGeneration.status = 'failed';
  videoGeneration.error = retrieved.error || 'Video retrieval did not return a playable video.';
  return { videoGeneration };
}

module.exports = {
  submitVideoGeneration,
  checkVideoGenerationStatus,
  retrieveGeneratedVideo,
  generateVideo,
  getProvider,
  PROVIDERS,
};
