// Resolves a Simple Story Video job's background-image LIBRARY selection
// (job-store.js's videoEditSettings.backgroundImageTrack) to one real,
// local image file for simple-story-video.js to use as every section's
// background instead of a solid color — the same "shared library of real
// local files the user placed here" pattern backend/music-library.js
// already uses for background music, parallel directory (data/backgrounds/
// here, data/music/ there).
//
// This app never generates these library images itself — the only
// sources are files the user places locally:
// - A shared "library" background: an entry in
//   data/backgrounds/manifest.json whose `file` points at a real image
//   file in data/backgrounds/. Ships with one bundled image by default
//   (unlike the music library, which ships empty).
// - videoEditSettings.backgroundImage: a one-off image not worth adding to
//   the shared library, given directly as an uploaded/generated url, a
//   data: URI, or a local path — see server.js's upload-background-image/
//   generate-background-image routes, which always take priority over a
//   library selection (see resolveJobBackgroundImagePath below).

const fs = require('fs');
const path = require('path');

const BACKGROUND_IMAGES_DIR = path.resolve(__dirname, '..', 'data', 'backgrounds');
const MANIFEST_PATH = path.join(BACKGROUND_IMAGES_DIR, 'manifest.json');

// Never throws: a missing or invalid manifest just means an empty library,
// not a startup failure — this is user-maintained local data, not a
// required app asset.
function loadBackgroundManifest() {
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
    console.error('data/backgrounds/manifest.json contains invalid JSON; treating the background library as empty.');
    return [];
  }
}

// { value, label } entries only — the frontend/agent select from these by
// value, never see or need the underlying file path.
function getBackgroundImageOptions() {
  return loadBackgroundManifest()
    .filter((entry) => entry && typeof entry.value === 'string' && typeof entry.file === 'string')
    .map((entry) => ({ value: entry.value, label: entry.label || entry.value }));
}

// Resolves a library background key to its real local file path,
// validating the file actually exists on disk — never silently ignored if
// the manifest points at an image whose file was removed after being
// selected.
function resolveBackgroundImageTrackPath(track) {
  const entry = loadBackgroundManifest().find((item) => item && item.value === track);
  if (!entry) {
    throw new Error(`Unknown background image "${track}" — it is not listed in data/backgrounds/manifest.json.`);
  }

  const filePath = path.join(BACKGROUND_IMAGES_DIR, entry.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Background image "${track}" is missing its file at data/backgrounds/${entry.file}.`);
  }

  return filePath;
}

// Resolves a job's ALREADY-NORMALIZED videoEditSettings to one real local
// image path simple-story-video.js's own fetchAudioToFile can read, or
// null when neither a library selection nor a direct backgroundImage is
// set — which is what keeps the final-video pipeline exactly as it was
// before this feature for any job that never touches either. A direct
// backgroundImage (uploaded/generated/custom) always takes priority over a
// library selection, the same "custom beats library" priority
// music-library.js's resolveJobMusicUrl already gives musicCustomUrl over
// musicTrack. Throws a clear, actionable error (never swallowed) if
// backgroundImageTrack names a library image that doesn't exist or whose
// file is missing.
function resolveJobBackgroundImagePath(editSettings) {
  if (!editSettings) {
    return null;
  }
  if (editSettings.backgroundImage) {
    return editSettings.backgroundImage;
  }
  if (editSettings.backgroundImageTrack) {
    return resolveBackgroundImageTrackPath(editSettings.backgroundImageTrack);
  }
  return null;
}

module.exports = {
  getBackgroundImageOptions,
  resolveBackgroundImageTrackPath,
  resolveJobBackgroundImagePath,
  BACKGROUND_IMAGES_DIR,
};
