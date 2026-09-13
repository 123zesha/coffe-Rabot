// Tests for backend/music-library.js — resolving a job's musicEnabled/
// musicTrack/musicCustomUrl settings to a real local audio source (or null
// when music is off/unset) for backend/video-assembly.js to mix in. No
// paid API involved at all; this only reads/writes local files under
// data/music/ (temporarily, restored afterward) to exercise the real
// manifest-loading and file-existence checks against real disk state.
//
// Run with:
//   node test-music-library.js
// or:
//   npm run test:music-library

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

// music-library.js resolves MUSIC_DIR/MANIFEST_PATH once at require time
// relative to its own __dirname — no env var to override for tests, so
// these tests operate on the real data/music/ directory directly (backed up
// and restored below), the same approach test-video-storage.js already
// takes for data/generated/.
const MUSIC_DIR = path.resolve(__dirname, '..', 'data', 'music');
const MANIFEST_PATH = path.join(MUSIC_DIR, 'manifest.json');
const TEST_TRACK_FILENAME = '__test-track.mp3';
const TEST_TRACK_PATH = path.join(MUSIC_DIR, TEST_TRACK_FILENAME);

async function main() {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const originalManifest = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, 'utf8') : null;
  const hadTestTrackFile = fs.existsSync(TEST_TRACK_PATH);

  try {
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify([{ value: 'test-track', label: 'Test Track', file: TEST_TRACK_FILENAME }], null, 2)
    );
    fs.writeFileSync(TEST_TRACK_PATH, 'fake mp3 bytes, never actually decoded by this test');

    // Fresh require so this test's own manifest.json write above (not
    // present when the module might have been required earlier in the same
    // process) is actually the one read — loadMusicManifest reads the file
    // fresh on every call rather than caching, but this keeps the pattern
    // consistent with this app's other require.cache-busting tests.
    delete require.cache[require.resolve('./music-library')];
    const musicLibrary = require('./music-library');

    await test('getMusicTrackOptions lists the real manifest entry as { value, label }', () => {
      const options = musicLibrary.getMusicTrackOptions();
      assert.deepStrictEqual(options, [{ value: 'test-track', label: 'Test Track' }]);
    });

    await test('resolveMusicTrackPath resolves a known track to its real, existing file on disk', () => {
      const resolved = musicLibrary.resolveMusicTrackPath('test-track');
      assert.strictEqual(resolved, TEST_TRACK_PATH);
      assert.ok(fs.existsSync(resolved));
    });

    await test('resolveMusicTrackPath throws a clear error for an unknown track', () => {
      assert.throws(() => musicLibrary.resolveMusicTrackPath('does-not-exist'), /Unknown music track/);
    });

    await test('resolveMusicTrackPath throws a clear error when the manifest entry\'s file is missing from disk', () => {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify([{ value: 'ghost-track', label: 'Ghost Track', file: '__does-not-exist.mp3' }], null, 2)
      );
      assert.throws(() => musicLibrary.resolveMusicTrackPath('ghost-track'), /missing its audio file/);
    });

    await test('resolveJobMusicUrl returns null when musicEnabled is false, regardless of other fields', () => {
      assert.strictEqual(
        musicLibrary.resolveJobMusicUrl({ musicEnabled: false, musicTrack: 'test-track', musicCustomUrl: 'x' }),
        null
      );
    });

    await test('resolveJobMusicUrl returns null when enabled but neither track nor customUrl is set', () => {
      assert.strictEqual(musicLibrary.resolveJobMusicUrl({ musicEnabled: true, musicTrack: null, musicCustomUrl: '' }), null);
    });

    await test('resolveJobMusicUrl prefers musicCustomUrl over musicTrack when both are set', () => {
      const url = musicLibrary.resolveJobMusicUrl({
        musicEnabled: true,
        musicTrack: 'test-track',
        musicCustomUrl: 'data:audio/mpeg;base64,AAAA',
      });
      assert.strictEqual(url, 'data:audio/mpeg;base64,AAAA');
    });

    await test('resolveJobMusicUrl resolves musicTrack to its real local file path when no customUrl is set', () => {
      // Restore the valid manifest (a previous test above intentionally
      // pointed it at a missing file).
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify([{ value: 'test-track', label: 'Test Track', file: TEST_TRACK_FILENAME }], null, 2)
      );
      const url = musicLibrary.resolveJobMusicUrl({ musicEnabled: true, musicTrack: 'test-track', musicCustomUrl: '' });
      assert.strictEqual(url, TEST_TRACK_PATH);
    });

    await test('getMusicTrackOptions returns an empty list for a missing/empty manifest (the shipped default)', () => {
      fs.writeFileSync(MANIFEST_PATH, '[]');
      assert.deepStrictEqual(musicLibrary.getMusicTrackOptions(), []);
    });
  } finally {
    if (originalManifest === null) {
      fs.rmSync(MANIFEST_PATH, { force: true });
    } else {
      fs.writeFileSync(MANIFEST_PATH, originalManifest);
    }
    if (!hadTestTrackFile) {
      fs.rmSync(TEST_TRACK_PATH, { force: true });
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll music-library tests passed.');
  }
}

main();
