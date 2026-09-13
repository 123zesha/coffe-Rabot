// Resolves a job's background-music settings (job-store.js: musicEnabled /
// musicTrack / musicCustomUrl) to one real, local audio source for
// backend/video-assembly.js to mix in — or null when music is off, which
// must leave the rest of the pipeline byte-for-byte unchanged.
//
// This app never downloads or generates music itself — the only sources
// are files the user places locally:
// - A shared "library" track: an entry in data/music/manifest.json whose
//   `file` points at a real audio file the user has put in data/music/.
//   Ships empty by default (no bundled audio).
// - musicCustomUrl: a one-off track not worth adding to the shared
//   library, given directly as a data: URI or local path — the same
//   shapes voiceover.url/images[].url already use.

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.resolve(__dirname, '..', 'data', 'music');
const MANIFEST_PATH = path.join(MUSIC_DIR, 'manifest.json');

// Never throws: a missing or invalid manifest just means an empty library,
// not a startup failure — this is user-maintained local data, not a
// required app asset.
function loadMusicManifest() {
  let raw;
  try {
    raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  } catch (error) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('data/music/manifest.json contains invalid JSON; treating the music library as empty.');
    return [];
  }
}

// { value, label } entries only — the frontend/agent select from these by
// value, never see or need the underlying file path.
function getMusicTrackOptions() {
  return loadMusicManifest()
    .filter((entry) => entry && typeof entry.value === 'string' && typeof entry.file === 'string')
    .map((entry) => ({ value: entry.value, label: entry.label || entry.value }));
}

// Resolves a library track key to its real local file path, validating the
// file actually exists on disk — never silently ignored if the manifest
// points at a track whose file was removed after being selected.
function resolveMusicTrackPath(track) {
  const entry = loadMusicManifest().find((item) => item && item.value === track);
  if (!entry) {
    throw new Error(`Unknown music track "${track}" — it is not listed in data/music/manifest.json.`);
  }

  const filePath = path.join(MUSIC_DIR, entry.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Music track "${track}" is missing its audio file at data/music/${entry.file}.`);
  }

  return filePath;
}

// Resolves a job's music settings to one source video-assembly.js's
// fetchToFile can read — or null when music is off/unset, which is what
// keeps the final-video pipeline exactly as it was before this feature for
// any job that never enables it. Throws a clear, actionable error (never
// swallowed) if musicTrack names a track that doesn't exist or whose file
// is missing.
function resolveJobMusicUrl(job) {
  if (!job || !job.musicEnabled) {
    return null;
  }
  if (job.musicCustomUrl) {
    return job.musicCustomUrl;
  }
  if (job.musicTrack) {
    return resolveMusicTrackPath(job.musicTrack);
  }
  return null;
}

module.exports = { getMusicTrackOptions, resolveMusicTrackPath, resolveJobMusicUrl, MUSIC_DIR };
