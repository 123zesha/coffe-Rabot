// Real video generation provider: Runway Gen-4 Turbo (image-to-video), via
// Runway's official developer API. This is the concrete implementation
// plugged into backend/video-generation.js's provider-independent
// submit/check/retrieve interface — nothing outside this file knows or
// cares that Runway happens to expose only two real endpoints (create task,
// get task) instead of three; that adaptation lives entirely here.
//
// API key: RUNWAYML_API_SECRET, read from the environment, server-side
// only. Never sent to the frontend, never logged.

// Overridable so integration tests can point this at a local mock server
// instead of the real Runway API — mirrors how the official OpenAI/
// Anthropic SDKs already respect OPENAI_BASE_URL/ANTHROPIC_BASE_URL for the
// same reason. Defaults to the real, documented Runway endpoint.
const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE_URL || 'https://api.dev.runwayml.com/v1';
// Pinned per Runway's documented header requirement, so a future change on
// their end can't silently alter this integration's behavior underneath us.
const RUNWAY_API_VERSION = '2024-11-06';
const RUNWAY_MODEL = 'gen4_turbo';

function getApiKey() {
  const key = process.env.RUNWAYML_API_SECRET;
  if (!key) {
    throw new Error('RUNWAYML_API_SECRET is not set.');
  }
  return key;
}

function headers() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': RUNWAY_API_VERSION,
  };
}

// Runway's task statuses (PENDING/RUNNING/THROTTLED/SUCCEEDED/FAILED/
// CANCELLED) map onto our three-state contract ('processing' | 'completed'
// | 'failed'). Anything not explicitly SUCCEEDED/FAILED/CANCELLED is
// treated as still in progress, never as done.
function mapStatus(runwayStatus) {
  if (runwayStatus === 'SUCCEEDED') return 'completed';
  if (runwayStatus === 'FAILED' || runwayStatus === 'CANCELLED') return 'failed';
  return 'processing';
}

function describeHttpError(status, body) {
  const detail = body && (body.error || body.message);
  return `Runway API error (HTTP ${status}${detail ? `: ${detail}` : ''})`;
}

function describeTaskFailure(task) {
  return (task && (task.failure || task.failureCode || task.error)) || 'Runway reported the task as failed.';
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

// Submits one image-to-video request. Only ever returns status 'processing'
// (Runway accepted the task) or 'failed' (rejected, or a network/HTTP
// error) — never 'completed'; Runway has no synchronous completion path.
async function submitVideoGeneration({ imageDataUri, prompt, durationSeconds, ratio }, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${RUNWAY_API_BASE}/image_to_video`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: RUNWAY_MODEL,
        promptImage: imageDataUri,
        promptText: prompt,
        duration: durationSeconds,
        ratio,
      }),
    });
    const data = await readJson(response);

    if (!response.ok || !data || !data.id) {
      return { status: 'failed', externalJobId: null, clips: [], error: describeHttpError(response.status, data) };
    }

    return { status: 'processing', externalJobId: data.id, clips: [], error: null };
  } catch (error) {
    return { status: 'failed', externalJobId: null, clips: [], error: error.message || 'Network error contacting Runway.' };
  }
}

async function getTask(externalJobId, fetchImpl) {
  const response = await fetchImpl(`${RUNWAY_API_BASE}/tasks/${externalJobId}`, {
    method: 'GET',
    headers: headers(),
  });
  const data = await readJson(response);
  return { response, data };
}

// Polls a previously submitted task. Runway's task response already
// contains the output URL once SUCCEEDED, but this function deliberately
// does not surface it — only retrieveGeneratedVideo is allowed to hand back
// a URL, keeping the "who may produce a playable result" boundary explicit
// even though, for this specific provider, both calls hit the same
// endpoint under the hood.
async function checkVideoGenerationStatus({ externalJobId }, fetchImpl = fetch) {
  try {
    const { response, data } = await getTask(externalJobId, fetchImpl);

    if (!response.ok || !data) {
      return { status: 'failed', clips: [], error: describeHttpError(response.status, data) };
    }

    const status = mapStatus(data.status);
    return { status, clips: [], error: status === 'failed' ? describeTaskFailure(data) : null };
  } catch (error) {
    return { status: 'failed', clips: [], error: error.message || 'Network error contacting Runway.' };
  }
}

// Retrieves the actual result. Runway has no separate "download" endpoint —
// this re-reads the same task resource and extracts output[0] — but a URL
// is only ever returned when Runway's own response reports SUCCEEDED and
// actually included one; nothing here ever invents one.
async function retrieveGeneratedVideo({ externalJobId }, fetchImpl = fetch) {
  try {
    const { response, data } = await getTask(externalJobId, fetchImpl);

    if (!response.ok || !data) {
      return { status: 'failed', url: null, error: describeHttpError(response.status, data) };
    }

    const status = mapStatus(data.status);

    if (status === 'completed') {
      const url = Array.isArray(data.output) ? data.output[0] : null;
      if (url) {
        return { status: 'completed', url, error: null };
      }
      return { status: 'failed', url: null, error: 'Runway reported the task as SUCCEEDED but returned no output URL.' };
    }

    return { status, url: null, error: status === 'failed' ? describeTaskFailure(data) : null };
  } catch (error) {
    return { status: 'failed', url: null, error: error.message || 'Network error contacting Runway.' };
  }
}

module.exports = {
  name: 'runway',
  submitVideoGeneration,
  checkVideoGenerationStatus,
  retrieveGeneratedVideo,
  RUNWAY_MODEL,
};
