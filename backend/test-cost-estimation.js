// Tests for backend/cost-estimation.js — a pure, deterministic module with
// no network/API calls of its own (nothing here spends anything real).
// Run with:
//   node test-cost-estimation.js
// or:
//   npm run test:cost-estimation

const assert = require('assert');
const { estimateProductionCost, estimateSpeechDurationSeconds } = require('./cost-estimation');

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

const SAMPLE_SCRIPT = 'a'.repeat(9000); // 9000 characters, ~10 estimated spoken minutes

test('estimateProductionCost returns an all-zero breakdown for an empty/missing script', () => {
  const result = estimateProductionCost({ script: '', videoMode: 'simple-story', generateYoutubePackage: false });
  assert.strictEqual(result.totalUsd, 0);
  assert.deepStrictEqual(result.breakdown, { voiceover: 0, subtitles: 0, thumbnail: 0, youtubePackageText: 0 });

  const missing = estimateProductionCost({});
  assert.strictEqual(missing.totalUsd, 0);
});

test('estimateProductionCost charges voiceover + subtitles for a real script even with no YouTube package', () => {
  const result = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', generateYoutubePackage: false });
  assert.ok(result.breakdown.voiceover > 0, 'a real script must have a non-zero estimated voiceover cost');
  assert.ok(result.breakdown.subtitles > 0, 'a real script must have a non-zero estimated subtitles cost');
  assert.strictEqual(result.breakdown.thumbnail, 0, 'no YouTube package requested — no thumbnail cost');
  assert.strictEqual(result.breakdown.youtubePackageText, 0, 'no YouTube package requested — no text-package cost');
  assert.strictEqual(result.totalUsd, result.breakdown.voiceover + result.breakdown.subtitles);
});

test('estimateProductionCost never charges for a thumbnail image in simple-story mode, even with the YouTube package on', () => {
  const result = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', generateYoutubePackage: true });
  assert.strictEqual(result.breakdown.thumbnail, 0, "simple-story's thumbnail is a free local ffmpeg frame, never a paid image call");
  assert.ok(result.breakdown.youtubePackageText > 0, 'the text half of the package is still a real Claude call');
});

test('estimateProductionCost charges for a real thumbnail image in cinematic mode with the YouTube package on', () => {
  const result = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'cinematic', generateYoutubePackage: true });
  assert.ok(result.breakdown.thumbnail > 0, 'cinematic mode uses a real, paid OpenAI image call for its thumbnail');
});

test('estimateProductionCost uses a real, measured voice-over duration to sharpen the subtitles estimate, never the voiceover estimate', () => {
  const scriptLengthOnly = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', generateYoutubePackage: false });
  const measured = estimateProductionCost({
    script: SAMPLE_SCRIPT,
    videoMode: 'simple-story',
    generateYoutubePackage: false,
    realVoiceoverDurationSeconds: 60, // much shorter than the script-length guess
  });

  assert.strictEqual(measured.breakdown.voiceover, scriptLengthOnly.breakdown.voiceover, 'voiceover cost is always driven by script characters, never duration');
  assert.notStrictEqual(measured.breakdown.subtitles, scriptLengthOnly.breakdown.subtitles, 'subtitles cost must reflect the real measured duration once known');
  assert.strictEqual(measured.estimatedDurationSeconds, 60);
  assert.strictEqual(measured.basis, 'measured-voiceover');
  assert.strictEqual(scriptLengthOnly.basis, 'script-length');
});

test('estimateProductionCost ignores an invalid/non-positive realVoiceoverDurationSeconds and falls back to the script-length guess', () => {
  const withZero = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', realVoiceoverDurationSeconds: 0 });
  const withNegative = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', realVoiceoverDurationSeconds: -5 });
  const withNaN = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story', realVoiceoverDurationSeconds: 'not a number' });
  const baseline = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story' });

  assert.strictEqual(withZero.basis, 'script-length');
  assert.strictEqual(withNegative.basis, 'script-length');
  assert.strictEqual(withNaN.basis, 'script-length');
  assert.deepStrictEqual(withZero.breakdown, baseline.breakdown);
});

test('estimateProductionCost always returns a plain-language, never-a-guaranteed-bill disclaimer', () => {
  const result = estimateProductionCost({ script: SAMPLE_SCRIPT, videoMode: 'simple-story' });
  assert.ok(typeof result.note === 'string' && result.note.length > 0);
  assert.ok(/estimate/i.test(result.note));
});

test('estimateSpeechDurationSeconds scales linearly with script length', () => {
  const short = estimateSpeechDurationSeconds(900);
  const long = estimateSpeechDurationSeconds(9000);
  assert.strictEqual(long, short * 10);
  assert.strictEqual(estimateSpeechDurationSeconds(0), 0);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll cost-estimation tests passed.');
}
