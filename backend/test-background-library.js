// Tests for backend/background-library.js — resolving a job's
// backgroundImage/backgroundImageTrack videoEditSettings to one real local
// image file for backend/simple-story-video.js to use as every section's
// background (or null when neither is set). No paid API involved at all;
// this only reads/writes local files under data/backgrounds/ (temporarily,
// restored afterward) to exercise the real manifest-loading and
// file-existence checks against real disk state.
//
// Run with:
//   node test-background-library.js
// or:
//   npm run test:background-library

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

// background-library.js resolves BACKGROUND_IMAGES_DIR/MANIFEST_PATH once at
// require time relative to its own __dirname — no env var to override for
// tests, so these tests operate on the real data/backgrounds/ directory
// directly (backed up and restored below), the same approach
// test-music-library.js already takes for data/music/.
const BACKGROUND_IMAGES_DIR = path.resolve(__dirname, '..', 'data', 'backgrounds');
const MANIFEST_PATH = path.join(BACKGROUND_IMAGES_DIR, 'manifest.json');
const TEST_IMAGE_FILENAME = '__test-image.webp';
const TEST_IMAGE_PATH = path.join(BACKGROUND_IMAGES_DIR, TEST_IMAGE_FILENAME);

async function main() {
  fs.mkdirSync(BACKGROUND_IMAGES_DIR, { recursive: true });
  const originalManifest = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, 'utf8') : null;
  const hadTestImageFile = fs.existsSync(TEST_IMAGE_PATH);

  try {
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify([{ value: 'test-image', label: 'Test Image', file: TEST_IMAGE_FILENAME }], null, 2)
    );
    fs.writeFileSync(TEST_IMAGE_PATH, 'fake webp bytes, never actually decoded by this test');

    // Fresh require so this test's own manifest.json write above is actually
    // the one read — loadBackgroundManifest reads the file fresh on every
    // call rather than caching, but this keeps the pattern consistent with
    // this app's other require.cache-busting tests.
    delete require.cache[require.resolve('./background-library')];
    const backgroundLibrary = require('./background-library');

    await test('getBackgroundImageOptions lists the real manifest entry as { value, label }', () => {
      const options = backgroundLibrary.getBackgroundImageOptions();
      assert.deepStrictEqual(options, [{ value: 'test-image', label: 'Test Image' }]);
    });

    await test('resolveBackgroundImageTrackPath resolves a known track to its real, existing file on disk', () => {
      const resolved = backgroundLibrary.resolveBackgroundImageTrackPath('test-image');
      assert.strictEqual(resolved, TEST_IMAGE_PATH);
      assert.ok(fs.existsSync(resolved));
    });

    await test('resolveBackgroundImageTrackPath throws a clear error for an unknown track', () => {
      assert.throws(() => backgroundLibrary.resolveBackgroundImageTrackPath('does-not-exist'), /Unknown background image/);
    });

    await test('resolveBackgroundImageTrackPath throws a clear error when the manifest entry\'s file is missing from disk', () => {
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify([{ value: 'ghost-image', label: 'Ghost Image', file: '__does-not-exist.webp' }], null, 2)
      );
      assert.throws(() => backgroundLibrary.resolveBackgroundImageTrackPath('ghost-image'), /missing its file/);
    });

    await test('resolveJobBackgroundImagePath returns null when neither backgroundImage nor backgroundImageTrack is set', () => {
      assert.strictEqual(backgroundLibrary.resolveJobBackgroundImagePath({ backgroundImage: null, backgroundImageTrack: null }), null);
    });

    await test('resolveJobBackgroundImagePath returns null for null/undefined editSettings', () => {
      assert.strictEqual(backgroundLibrary.resolveJobBackgroundImagePath(null), null);
      assert.strictEqual(backgroundLibrary.resolveJobBackgroundImagePath(undefined), null);
    });

    await test('resolveJobBackgroundImagePath prefers a direct backgroundImage over backgroundImageTrack when both are set', () => {
      const resolved = backgroundLibrary.resolveJobBackgroundImagePath({
        backgroundImage: '/generated/some-image.png',
        backgroundImageTrack: 'test-image',
      });
      assert.strictEqual(resolved, '/generated/some-image.png');
    });

    await test('resolveJobBackgroundImagePath resolves backgroundImageTrack to its real local file path when no direct backgroundImage is set', () => {
      // Restore the valid manifest (a previous test above intentionally
      // pointed it at a missing file).
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify([{ value: 'test-image', label: 'Test Image', file: TEST_IMAGE_FILENAME }], null, 2)
      );
      const resolved = backgroundLibrary.resolveJobBackgroundImagePath({ backgroundImage: null, backgroundImageTrack: 'test-image' });
      assert.strictEqual(resolved, TEST_IMAGE_PATH);
    });

    await test('getBackgroundImageOptions returns an empty list for a missing/empty manifest', () => {
      fs.writeFileSync(MANIFEST_PATH, '[]');
      assert.deepStrictEqual(backgroundLibrary.getBackgroundImageOptions(), []);
    });
  } finally {
    if (originalManifest === null) {
      fs.rmSync(MANIFEST_PATH, { force: true });
    } else {
      fs.writeFileSync(MANIFEST_PATH, originalManifest);
    }
    if (!hadTestImageFile) {
      fs.rmSync(TEST_IMAGE_PATH, { force: true });
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll background-library tests passed.');
  }
}

main();
