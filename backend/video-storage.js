// Stores a real media file's bytes OUTSIDE the job record itself, returning
// only a lightweight reference — a real URL. Used for the assembled final
// MP4 (produced by backend/video-assembly.js, for job.finalVideo.url),
// since Runway's own download links expire (see storeSceneClip below), each
// scene's individual clip too (job.videoGeneration.clips[i].url), the
// generated voice-over audio (job.voiceover.url, produced by
// backend/voiceover-generation.js), and every generated scene/thumbnail
// image (job.images[].url, job.youtubePackage.thumbnailUrl, produced by
// backend/image-generation.js).
//
// Embedding any of this media directly as a base64 data: URI in the job
// record risks Redis/Upstash's REST API maximum payload size per request
// (see job-store.js's per-job-key comment for the exact failure mode this
// caused before: an oversized write throws and silently discards an
// already-completed, already-paid-for result). A single image or a real
// 15-20 minute voice-over track can individually run to multiple MB, and
// several scene images in one job add up fast — this is exactly what
// happened to real voice-over and multi-scene image generations before
// each was routed through here instead of an inline data: URI. Storing
// this media outside the job record entirely, and only its URL inside,
// keeps every job read/write small and bounded regardless of how large or
// how numerous the underlying files are.
//
// - Production (or any environment with BLOB_READ_WRITE_TOKEN set — Vercel
//   provisions this automatically once a Blob store is connected to the
//   project): uploads to Vercel Blob (@vercel/blob), a first-party object
//   storage product built for exactly this — a serverless function
//   producing a file that needs a stable, public URL afterward. Returns
//   that store's own real https:// URL. `multipart: true` is used so this
//   scales to a large video without needing to change this code.
// - Local dev/tests (no BLOB_READ_WRITE_TOKEN): writes the file to
//   data/generated/ and returns a path served back by server.js's existing
//   Express static file server — the same "real Redis vs. local-file
//   fallback" duality job-store.js already uses for the same reason
//   (Vercel's deployed filesystem is read-only; see IS_SERVERLESS_PRODUCTION
//   there). This local path is for development and this module's own tests
//   only, not a production storage solution.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATED_DIR = path.resolve(__dirname, '..', 'data', 'generated');

function hasBlobToken() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Shared core for storeFinalVideo/storeSceneClip below — the two only
// differ in what filename prefix identifies the video they're storing.
// `putBlob`, when passed, replaces the real @vercel/blob `put` call — used
// only by this module's own tests, so they can verify the routing logic
// (Vercel Blob vs. local-file fallback) without making a real network call
// to Vercel Blob. Production code never passes it; the real `put` is always
// used whenever BLOB_READ_WRITE_TOKEN is actually configured.
async function storeMediaFile(buffer, filenamePrefix, { putBlob, extension = 'mp4', contentType = 'video/mp4' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('storeMediaFile requires a non-empty media buffer.');
  }

  // Random, not sequential/content-derived: two stores for the same
  // job/scene (e.g. a retry after a failed one, or recovering an expired
  // Runway link) must never collide on the same filename while an older
  // upload might still be referenced elsewhere.
  const filename = `${filenamePrefix}-${crypto.randomBytes(8).toString('hex')}.${extension}`;

  if (hasBlobToken()) {
    const put = putBlob || require('@vercel/blob').put;
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      multipart: true,
    });
    return blob.url;
  }

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
  return `/generated/${filename}`;
}

async function storeFinalVideo(buffer, jobId, options) {
  return storeMediaFile(buffer, `final-video-${jobId}`, options);
}

// Stores one scene's real video clip bytes permanently. This exists because
// Runway's own task-output URL (job.videoGeneration.clips[i].url as
// originally retrieved) is a temporary, signed CloudFront link that Runway's
// own docs say expires within 24-48 hours of the API call that produced it
// — see backend/video-generation.js's ensureClipStored, which downloads and
// calls this the moment a clip is retrieved as 'completed', so the job
// record never depends on that link staying alive.
async function storeSceneClip(buffer, jobId, sceneIndex, options) {
  return storeMediaFile(buffer, `scene-clip-${jobId}-${sceneIndex}`, options);
}

// Stores the generated voice-over's real MP3 bytes for one job. See this
// module's own top comment for why job.voiceover.url can no longer safely
// embed the audio directly as a data: URI once the script is long enough
// (this app targets 15-20 minute videos) to push the base64-encoded track
// past Redis/Upstash's per-request payload limit.
async function storeAudioFile(buffer, jobId, options) {
  return storeMediaFile(buffer, `voiceover-${jobId}`, { ...options, extension: 'mp3', contentType: 'audio/mpeg' });
}

// Stores one generated scene/thumbnail image's real PNG bytes for one job.
// See this module's own top comment for why job.images[].url can no longer
// safely embed images directly as data: URIs once enough scenes (or one
// large enough image) push the combined base64 past Redis/Upstash's
// per-request payload limit — the exact failure a real production job hit
// generating 8 scene images.
async function storeImageFile(buffer, jobId, options) {
  return storeMediaFile(buffer, `image-${jobId}`, { ...options, extension: 'png', contentType: 'image/png' });
}

module.exports = { storeFinalVideo, storeSceneClip, storeAudioFile, storeImageFile, hasBlobToken, GENERATED_DIR };
