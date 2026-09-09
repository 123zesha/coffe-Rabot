// Stores a real, assembled final video file's bytes (produced by
// backend/video-assembly.js) OUTSIDE the job record itself, returning only
// a lightweight reference — a real URL — for job.finalVideo.url.
//
// job.images[].url and job.voiceover.url already embed their real media
// directly as base64 data: URIs, which works because a single generated
// image or voice-over track is realistically hundreds of KB. An assembled,
// multi-scene final video is a different order of magnitude — easily tens
// of MB — and Redis/Upstash's REST API enforces a maximum payload size per
// request (see job-store.js's per-job-key comment for the exact failure
// mode this caused before: an oversized write throws and silently discards
// an already-completed, already-paid-for result). Storing the video outside
// the job record entirely, and only its URL inside, keeps every job
// read/write small and bounded regardless of how large the video is.
//
// - Production (or any environment with BLOB_READ_WRITE_TOKEN set — Vercel
//   provisions this automatically once a Blob store is connected to the
//   project): uploads to Vercel Blob (@vercel/blob), a first-party object
//   storage product built for exactly this — a serverless function
//   producing a file that needs a stable, public URL afterward. Returns
//   that store's own real https:// URL. `multipart: true` is used so this
//   scales to a large final video without needing to change this code.
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

// `putBlob`, when passed, replaces the real @vercel/blob `put` call — used
// only by this module's own tests, so they can verify the routing logic
// (Vercel Blob vs. local-file fallback) without making a real network call
// to Vercel Blob. Production code never passes it; the real `put` is always
// used whenever BLOB_READ_WRITE_TOKEN is actually configured.
async function storeFinalVideo(buffer, jobId, { putBlob } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('storeFinalVideo requires a non-empty video buffer.');
  }

  // Random, not sequential/content-derived: two assemblies of the same job
  // (e.g. a retry after a failed one) must never collide on the same
  // filename while an older upload might still be referenced elsewhere.
  const filename = `final-video-${jobId}-${crypto.randomBytes(8).toString('hex')}.mp4`;

  if (hasBlobToken()) {
    const put = putBlob || require('@vercel/blob').put;
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: false,
      multipart: true,
    });
    return blob.url;
  }

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
  return `/generated/${filename}`;
}

module.exports = { storeFinalVideo, hasBlobToken, GENERATED_DIR };
