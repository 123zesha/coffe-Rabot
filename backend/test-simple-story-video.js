// Regression tests for backend/simple-story-video.js — the local,
// FFmpeg-only "Simple Story Video" mode assembly pipeline. Uses only real,
// local ffmpeg (a synthesized tone as a stand-in for real narration audio,
// via ffmpeg's own lavfi sine generator) and hand-written .srt fixtures —
// makes ZERO calls to Runway, OpenAI, or Anthropic. Run with:
//   node test-simple-story-video.js
// or:
//   npm run test:simple-story-video

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFile } = require('child_process');

const ssv = require('./simple-story-video');

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ssv.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || '').toString().trim().slice(-1000) || error.message));
        return;
      }
      resolve();
    });
  });
}

// Real decoded dimensions/duration, read from ffmpeg's own decode log —
// never trusted from a requested value, same discipline test-video-
// assembly.js uses for the Runway pipeline's own tests.
function probe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ssv.ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      const log = (stderr || '').toString();
      const durationMatch = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const dimensionMatch = log.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!durationMatch || !dimensionMatch) {
        reject(new Error(`Could not probe ${filePath}: ${log.trim().slice(-500)}`));
        return;
      }
      resolve({
        duration: Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]),
        width: Number(dimensionMatch[1]),
        height: Number(dimensionMatch[2]),
      });
    });
  });
}

// Same idea as probe() above, but for an audio-only file (no video stream,
// so probe()'s dimensionMatch requirement would never be satisfied).
function probeAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ssv.ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      const log = (stderr || '').toString();
      const durationMatch = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!durationMatch) {
        reject(new Error(`Could not probe audio duration for ${filePath}: ${log.trim().slice(-500)}`));
        return;
      }
      resolve(Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]));
    });
  });
}

// Reads one raw RGB pixel from a real decoded video frame at `atSeconds` —
// used to prove a requested backgroundColor edit genuinely changed the
// rendered pixels, not just that re-rendering happened. (x, y) should land
// on plain background, away from any burned-in text box.
async function probePixelColor(filePath, atSeconds, x, y) {
  const rawPath = `${filePath}.raw.rgb`;
  await runFfmpeg([
    '-y',
    '-ss',
    String(atSeconds),
    '-i',
    filePath,
    '-vframes',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    rawPath,
  ]);
  const buffer = fs.readFileSync(rawPath);
  const width = ssv.SIMPLE_STORY_WIDTH;
  const offset = (y * width + x) * 3;
  const pixel = { r: buffer[offset], g: buffer[offset + 1], b: buffer[offset + 2] };
  fs.rmSync(rawPath, { force: true });
  return pixel;
}

let toneAudioCounter = 0;

// `label` (defaulting to an auto-incrementing counter) guarantees a
// distinct file path/url even for two tones of the identical duration —
// needed so tests can produce two genuinely different "voice-over" urls to
// exercise staleness detection, not two calls that happen to collide on
// the same `tone-${seconds}.mp3` filename.
function makeToneAudio(dir, seconds, label) {
  const outPath = path.join(dir, `tone-${seconds}-${label || ++toneAudioCounter}.mp3`);
  return runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-c:a', 'libmp3lame', outPath]).then(
    () => outPath
  );
}

// Builds a real, longer .srt fixture (real timestamps, real sequential
// cues) to simulate a production-length story without ever generating a
// real production-length video — used only for the end-to-end resumability
// simulation below, where the real POINT is exercising many separate
// continueSimpleStoryVideoAssembly calls, not the exact narration content.
function buildLongSrt(cueCount, cueDurationSeconds, gapSeconds) {
  const lines = [];
  let t = 0;
  let n = 1;
  const toSrtTimestamp = (seconds) => {
    const hh = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    const ss = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  for (let i = 0; i < cueCount; i++) {
    const start = t;
    const end = t + cueDurationSeconds;
    lines.push(String(n++), `${toSrtTimestamp(start)} --> ${toSrtTimestamp(end)}`, 'A short line of story narration text.', '');
    t = end + gapSeconds;
  }
  return { srt: lines.join('\n'), totalSeconds: t };
}

const FIXTURE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,500',
  'Once upon a time, in a small village, there lived a curious young fox.',
  '',
  '2',
  '00:00:02,500 --> 00:00:04,800',
  'She loved to explore the forest every morning.',
  '',
  '3',
  '00:00:05,200 --> 00:00:07,000',
  'One day, she found a hidden path she had never seen before.',
  '',
  '4',
  '00:00:07,000 --> 00:00:08,900',
  'It led her to a quiet, sunlit clearing.',
  '',
].join('\n');

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-simple-story-video-'));

  await test('parseSrt extracts real cues with correct start/end/text, sorted by start', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    assert.strictEqual(cues.length, 4);
    assert.strictEqual(cues[0].start, 0);
    assert.strictEqual(cues[0].end, 2.5);
    assert.ok(cues[0].text.includes('curious young fox'));
    assert.strictEqual(cues[3].end, 8.9);
    for (let i = 1; i < cues.length; i++) {
      assert.ok(cues[i].start >= cues[i - 1].start, 'cues must be sorted by start time');
    }
  });

  await test('parseSrt drops blocks with no real text and tolerates trailing whitespace', () => {
    const withBlank = FIXTURE_SRT + '\n5\n00:00:09,000 --> 00:00:09,500\n \n';
    const cues = ssv.parseSrt(withBlank);
    assert.strictEqual(cues.length, 4, 'a cue with only whitespace text must be dropped, not counted');
  });

  await test('groupCuesIntoSections splits by real elapsed time, never mid-story, and covers the full duration', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const sections = ssv.groupCuesIntoSections(cues, 3, 9);
    assert.ok(sections.length >= 2, 'a 9s fixture with a 3s section target must produce multiple sections');
    assert.strictEqual(sections[0].start, 0);
    assert.strictEqual(sections[sections.length - 1].end, 9, 'the last section must extend to the real total duration');
    for (let i = 1; i < sections.length; i++) {
      assert.strictEqual(sections[i].start, sections[i - 1].end, 'sections must be contiguous with no gap or overlap');
    }
  });

  await test('groupCuesIntoSections returns one section covering everything when the target exceeds total duration', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const sections = ssv.groupCuesIntoSections(cues, 999, 9);
    assert.strictEqual(sections.length, 1);
    assert.strictEqual(sections[0].start, 0);
    assert.strictEqual(sections[0].end, 9);
  });

  await test('wrapText never drops real text, even when it must merge overflow onto the last line', () => {
    const longText = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    const lines = ssv.wrapText(longText, 20, 2);
    assert.strictEqual(lines.length, 2);
    const rejoined = lines.join(' ');
    for (const word of longText.split(' ')) {
      assert.ok(rejoined.includes(word), `expected "${word}" to survive wrapping`);
    }
  });

  await test('wrapText respects the per-line character budget when it does not need to merge', () => {
    const lines = ssv.wrapText('short story text here', 100, 3);
    assert.strictEqual(lines.length, 1, 'text well under the budget should not be wrapped at all');
  });

  await test('fitCueText picks a smaller font and more lines for a long cue, never truncating it', () => {
    const longCue =
      'This is a much longer sentence than the others, written to force the layout to fall back ' +
      'to a smaller font size and more lines while still keeping every single word of the real narration.';
    const { fontSize, lines } = ssv.fitCueText(longCue);
    assert.ok(fontSize <= 72);
    const rejoined = lines.join(' ');
    for (const word of longCue.split(' ')) {
      assert.ok(rejoined.includes(word.replace(/[.,]$/, '')), `expected "${word}" to survive fitCueText`);
    }
  });

  await test('buildAssScript holds each cue\'s story text until the NEXT cue begins (never blanks during a pause)', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT); // cue 2 ends at 4.8, cue 3 starts at 5.2 — a real 0.4s pause
    const ass = ssv.buildAssScript(cues, 9);
    const storyLines = ass.split('\n').filter((line) => line.includes(',Story,'));
    assert.strictEqual(storyLines.length, cues.length);
    // The second cue's Story dialogue End time must reach cue 3's start
    // (5.2s = ASS timestamp 0:00:05.20), not its own transcribed end (4.8s).
    assert.ok(storyLines[1].includes('0:00:05.20'), `expected cue 2's story text to hold until 5.2s, got: ${storyLines[1]}`);
  });

  // --- cuesForSection: the correctness property the per-section text
  // burn-in refactor relies on — a cue's "hold until next cue" span (see
  // buildAssScript) must never actually need to reach past its own
  // section's end, since groupCuesIntoSections only ever starts a new
  // section exactly at some cue's own start time.

  await test('cuesForSection assigns each cue to exactly the section containing its real start time', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const sections = ssv.groupCuesIntoSections(cues, 3, 9); // forces multiple sections
    const allAssigned = sections.flatMap((section) => ssv.cuesForSection(cues, section));
    assert.strictEqual(allAssigned.length, cues.length, 'every cue must be assigned to exactly one section, none dropped or duplicated');
  });

  await test('cuesForSection localizes cue timestamps to the section\'s own 0-based timeline', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const sections = ssv.groupCuesIntoSections(cues, 3, 9);
    const secondSection = sections[1];
    const localCues = ssv.cuesForSection(cues, secondSection);
    for (const cue of localCues) {
      assert.ok(cue.start >= 0, 'localized start must never be negative');
      assert.ok(cue.end <= secondSection.end - secondSection.start + 0.001, 'localized end must never exceed the section\'s own length');
    }
  });

  await test('cuesForSection + buildAssScript reproduces the exact same story-hold timing as the original single global pass', () => {
    // This is the core correctness claim of moving text burn-in per-section:
    // cue 2 previously held its Story text until cue 3's global start
    // (5.2s) via ONE global ASS script. With a 2s section target, cue 2
    // (start 2.5s) and cue 3 (start 5.2s) land in DIFFERENT, non-zero-start
    // sections — proving the LOCAL, per-section version still holds cue 2's
    // text all the way to its own section's end (which equals cue 3's
    // global start, by construction — see cuesForSection's own comment),
    // not just in the trivial case where a section happens to start at 0.
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const sections = ssv.groupCuesIntoSections(cues, 2, 9);
    const cue2Section = sections.find((s) => 2.5 >= s.start && 2.5 < s.end);
    const cue3Section = sections.find((s) => 5.2 >= s.start && 5.2 < s.end);
    assert.notStrictEqual(cue2Section, cue3Section, 'test setup: cue 2 and cue 3 must land in different sections for this to be meaningful');
    assert.notStrictEqual(cue2Section.start, 0, 'test setup: cue 2\'s section must not start at 0, to actually exercise localization');
    assert.strictEqual(cue2Section.end, 5.2, 'sanity check: this section must end exactly at cue 3\'s global start time');

    const localCues = ssv.cuesForSection(cues, cue2Section);
    const sectionDuration = cue2Section.end - cue2Section.start;
    const ass = ssv.buildAssScript(localCues, sectionDuration);
    const storyLines = ass.split('\n').filter((line) => line.includes(',Story,'));
    const lastStoryLine = storyLines[storyLines.length - 1];

    const expectedLocalEnd = ssv.secondsToAssTimestamp(sectionDuration);
    assert.ok(
      lastStoryLine.includes(expectedLocalEnd),
      `expected the section's last cue to hold until the section's own local end (${expectedLocalEnd}), got: ${lastStoryLine}`
    );
  });

  await test('continueSimpleStoryVideoAssembly refuses without a completed voice-over', async () => {
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'pending', url: null },
      subtitlesContent: FIXTURE_SRT,
      jobId: 'test-job-1',
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(/voice-over/i.test(result.error));
  });

  await test('continueSimpleStoryVideoAssembly refuses without real subtitles content', async () => {
    const audioPath = await makeToneAudio(workDir, 9);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: '',
      jobId: 'test-job-2',
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(/subtitles/i.test(result.error));
  });

  await test('continueSimpleStoryVideoAssembly produces a real 1920x1080 MP4 with genuine audio, matching the real audio duration', async () => {
    const audioPath = await makeToneAudio(workDir, 9);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId: 'test-job-3',
      sectionTargetSeconds: 3, // forces multiple real sections/transitions from this short fixture
    });

    assert.strictEqual(result.status, 'completed', result.error);
    assert.ok(result.buffer && result.buffer.length > 0);
    assert.strictEqual(result.render.status, 'completed');
    assert.ok(result.render.sections.every((section) => section.status === 'completed'));

    const outPath = path.join(workDir, 'output.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);

    assert.strictEqual(probed.width, ssv.SIMPLE_STORY_WIDTH);
    assert.strictEqual(probed.height, ssv.SIMPLE_STORY_HEIGHT);
    assert.ok(Math.abs(probed.duration - 9) < 0.3, `expected ~9s duration, got ${probed.duration}`);
  });

  // --- mapWithConcurrencyUntilDeadline: the scheduling fix for the real
  // production timeout (many independent section renders previously ran
  // one at a time in a for-loop) — tested directly with synthetic timed
  // tasks, no ffmpeg needed, since what's new here is the scheduling
  // algorithm itself, not renderSection's own output (already covered
  // above).

  await test('mapWithConcurrencyUntilDeadline preserves input order regardless of which task finishes first', async () => {
    const delays = [30, 5, 20, 1, 10]; // deliberately out of order
    const results = await ssv.mapWithConcurrencyUntilDeadline(delays, 3, null, (delay, i) => new Promise((resolve) => setTimeout(() => resolve(i), delay)));
    assert.deepStrictEqual(results, [0, 1, 2, 3, 4], 'results must stay in original item order, not completion order');
  });

  await test('mapWithConcurrencyUntilDeadline never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await ssv.mapWithConcurrencyUntilDeadline(items, 4, null, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
    });

    assert.ok(maxActive <= 4, `expected at most 4 concurrent tasks, observed ${maxActive}`);
    assert.strictEqual(maxActive, 4, 'expected the limit to actually be reached with 10 items and a limit of 4');
  });

  await test('mapWithConcurrencyUntilDeadline handles fewer items than the concurrency limit', async () => {
    const results = await ssv.mapWithConcurrencyUntilDeadline([1, 2], 4, null, async (n) => n * 10);
    assert.deepStrictEqual(results, [10, 20]);
  });

  await test('mapWithConcurrencyUntilDeadline propagates a rejection from any task', async () => {
    await assert.rejects(
      () => ssv.mapWithConcurrencyUntilDeadline([1, 2, 3], 2, null, async (n) => {
        if (n === 2) throw new Error('simulated task failure');
        return n;
      }),
      /simulated task failure/
    );
  });

  await test('mapWithConcurrencyUntilDeadline runs meaningfully faster than sequential execution for independent tasks', async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const taskDurationMs = 25;

    const start = Date.now();
    await ssv.mapWithConcurrencyUntilDeadline(items, 4, null, () => new Promise((resolve) => setTimeout(resolve, taskDurationMs)));
    const elapsed = Date.now() - start;

    // 8 tasks at limit 4 = 2 sequential rounds ~= 50ms; 8 sequential tasks
    // would be ~200ms. A generous ceiling well below the sequential total
    // avoids flakiness on a slow CI machine while still proving real
    // parallelism is happening, not an accidental serial fallback.
    assert.ok(elapsed < taskDurationMs * 6, `expected parallel execution to be well under sequential time, took ${elapsed}ms`);
  });

  await test('mapWithConcurrencyUntilDeadline stops starting new work once the deadline passes, letting in-flight work finish', async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const started = [];
    const deadlineAt = Date.now() + 30;

    const results = await ssv.mapWithConcurrencyUntilDeadline(items, 2, deadlineAt, async (n) => {
      started.push(n);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return n * 10;
    });

    assert.ok(started.length < items.length, `expected fewer than all ${items.length} items to start, got ${started.length}`);
    assert.ok(started.length > 0, 'expected at least some items to start before the deadline stopped new work');
    for (let i = 0; i < started.length; i++) {
      assert.strictEqual(results[started[i]], started[i] * 10, 'every item that DID start must still finish and produce a real result');
    }
  });

  await test('mapWithConcurrencyUntilDeadline always starts at least one item even if the deadline already passed', async () => {
    const results = await ssv.mapWithConcurrencyUntilDeadline([1, 2, 3], 2, Date.now() - 1000, async (n) => n * 10);
    assert.strictEqual(results[0], 10, 'the first item must still run — a stale/already-passed deadline must never mean zero progress');
  });

  await test('continueSimpleStoryVideoAssembly renders multiple real sections — same correct output as before parallelism/resumability existed', async () => {
    // Reproduces the real production shape: more than one section from one
    // job (this fixture's cue spacing plus a 3s target produces 2 real
    // sections from an 18s audio track — the last one padded out to cover
    // the trailing silence). SECTION_RENDER_CONCURRENCY's bounded-parallel
    // scheduling itself (more items than the concurrency limit) is
    // covered directly by the mapWithConcurrencyUntilDeadline unit tests
    // above with synthetic tasks; this test is about real ffmpeg output
    // correctness, never a real production-length video.
    const audioPath = await makeToneAudio(workDir, 18);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId: 'test-job-parallel',
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(result.status, 'completed', result.error);
    const outPath = path.join(workDir, 'output-parallel-sections.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);

    assert.strictEqual(probed.width, ssv.SIMPLE_STORY_WIDTH);
    assert.strictEqual(probed.height, ssv.SIMPLE_STORY_HEIGHT);
    assert.ok(Math.abs(probed.duration - 18) < 0.3, `expected ~18s duration, got ${probed.duration}`);
  });

  await test('continueSimpleStoryVideoAssembly pads the video to the real audio duration when cues end early', async () => {
    // Audio runs 12s but the fixture's last cue ends at 8.9s — the video
    // must never truncate real narration; the last section's own render is
    // extended to cover the remaining ~3.1s instead (see this module's own
    // comment on why that replaced a separate global padding pass).
    const audioPath = await makeToneAudio(workDir, 12);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId: 'test-job-padded',
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(result.status, 'completed', result.error);
    const outPath = path.join(workDir, 'output-padded.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);
    assert.ok(Math.abs(probed.duration - 12) < 0.3, `expected the video to be padded out to ~12s, got ${probed.duration}`);
  });

  // --- Resumability: the actual point of this task. A real production job
  // could not finish 16 sections inside one 300s Vercel invocation.
  // timeBudgetMs simulates that boundary with a real, short cutoff instead
  // of needing an actual multi-minute fixture — the SAME real ffmpeg
  // section-rendering code path runs either way.

  await test('continueSimpleStoryVideoAssembly stops with status "in_progress" when the time budget runs out before every section is done', async () => {
    const audioPath = await makeToneAudio(workDir, 18);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId: 'test-job-resume-1',
      sectionTargetSeconds: 3, // 2 real sections from this fixture's cue spacing
      timeBudgetMs: 1, // expires before every section can start
    });

    assert.strictEqual(result.status, 'in_progress', JSON.stringify(result));
    assert.strictEqual(result.render.status, 'in_progress');
    assert.strictEqual(result.render.totalSections, 2);
    assert.ok(result.render.sections.some((section) => section.status === 'pending'), 'at least one section must still be pending');
    assert.strictEqual(result.buffer, undefined, 'must never return a buffer while sections remain unrendered');
  });

  await test('continueSimpleStoryVideoAssembly resumes from persisted progress instead of re-rendering already-completed sections', async () => {
    const audioPath = await makeToneAudio(workDir, 18);
    const jobId = 'test-job-resume-2';

    // First call: a real but tiny time budget lets at least one section
    // through (mapWithConcurrencyUntilDeadline always starts at least one
    // item per worker) but not all 6.
    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      sectionTargetSeconds: 3,
      timeBudgetMs: 1,
    });
    assert.strictEqual(first.status, 'in_progress', JSON.stringify(first));
    const completedUrlsAfterFirstCall = first.render.sections.map((s) => s.url);
    const completedCountAfterFirstCall = first.render.sections.filter((s) => s.status === 'completed').length;
    assert.ok(completedCountAfterFirstCall > 0, 'the first call must make some real progress');
    assert.ok(completedCountAfterFirstCall < 6, 'test setup: the first call must NOT finish everything, or this test proves nothing');

    // Second call: same voiceover/subtitles, existingRender = the first
    // call's own progress, and a real, generous time budget to finish.
    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      existingRender: first.render,
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(second.status, 'completed', second.error);
    assert.ok(second.render.sections.every((section) => section.status === 'completed'));

    // The DEFINITIVE proof of no wasted re-rendering: storeSimpleStorySectionClip
    // gives every real render a brand-new random filename (see
    // video-storage.js), so a section already completed by the first call
    // must keep the EXACT SAME url in the second call's final result —
    // a different url would mean it was thrown away and rendered again.
    for (let i = 0; i < completedUrlsAfterFirstCall.length; i++) {
      if (completedUrlsAfterFirstCall[i]) {
        assert.strictEqual(
          second.render.sections[i].url,
          completedUrlsAfterFirstCall[i],
          `section ${i} was already completed by the first call and must not have been re-rendered`
        );
      }
    }

    const outPath = path.join(workDir, 'output-resumed.mp4');
    fs.writeFileSync(outPath, second.buffer);
    const probed = await probe(outPath);
    assert.strictEqual(probed.width, ssv.SIMPLE_STORY_WIDTH);
    assert.ok(Math.abs(probed.duration - 18) < 0.3, `expected ~18s duration, got ${probed.duration}`);
  });

  await test('continueSimpleStoryVideoAssembly discards stale progress and starts over when the voice-over url changes', async () => {
    const audioPathA = await makeToneAudio(workDir, 9);
    const audioPathB = await makeToneAudio(workDir, 9);
    const jobId = 'test-job-stale-voiceover';

    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPathA },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      sectionTargetSeconds: 3,
    });
    assert.strictEqual(first.status, 'completed', first.error);

    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPathB }, // a "fresh" voice-over
      subtitlesContent: FIXTURE_SRT,
      jobId,
      existingRender: first.render,
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(second.status, 'completed', second.error);
    assert.strictEqual(second.render.audioUrlSnapshot, audioPathB);
    // A real rebuild, not a reuse: every section's url must be a fresh one.
    for (let i = 0; i < first.render.sections.length; i++) {
      assert.notStrictEqual(
        second.render.sections[i].url,
        first.render.sections[i].url,
        'stale progress from the old voice-over must never be reused for a new one'
      );
    }
  });

  await test('continueSimpleStoryVideoAssembly discards stale progress and starts over when subtitles content changes', async () => {
    const audioPath = await makeToneAudio(workDir, 9);
    const jobId = 'test-job-stale-subtitles';
    const CHANGED_SRT = FIXTURE_SRT.replace('curious young fox', 'brave little rabbit');

    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      sectionTargetSeconds: 3,
    });
    assert.strictEqual(first.status, 'completed', first.error);

    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: CHANGED_SRT,
      jobId,
      existingRender: first.render,
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(second.status, 'completed', second.error);
    assert.strictEqual(second.render.subtitlesContentSnapshot, CHANGED_SRT);
    for (let i = 0; i < first.render.sections.length; i++) {
      assert.notStrictEqual(
        second.render.sections[i].url,
        first.render.sections[i].url,
        'stale progress from the old subtitles must never be reused for changed text'
      );
    }
  });

  await test('continueSimpleStoryVideoAssembly progress accumulates monotonically across repeated partial calls, never regressing', async () => {
    const audioPath = await makeToneAudio(workDir, 18);
    const jobId = 'test-job-monotonic';

    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      sectionTargetSeconds: 3,
      timeBudgetMs: 1,
    });
    assert.strictEqual(first.status, 'in_progress');
    const completedCount = first.render.sections.filter((s) => s.status === 'completed').length;
    assert.ok(completedCount > 0);

    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      jobId,
      existingRender: first.render,
      sectionTargetSeconds: 3,
      timeBudgetMs: 1,
    });

    // Another tiny budget: still not necessarily finished, but must never
    // have lost the sections the first call already completed.
    assert.notStrictEqual(second.status, 'failed', second.error);
    const stillCompleted = second.render.sections.filter((s) => s.status === 'completed').length;
    assert.ok(stillCompleted >= completedCount, 'sections already completed by an earlier call must never be lost by a later one');
  });

  await test('end-to-end: a real production-shaped job (20 sections) completes across several short calls, none anywhere near a real timeout', async () => {
    // Directly reproduces the real production failure this whole feature
    // exists to fix: real Vercel logs showed a 16-section job stuck at
    // "10/16 sections rendered" after 248-249 real seconds — one HTTP
    // request could not finish it. This builds a comparable-sized job (a
    // ~16-minute simulated story, 20 sections at the default 45s target)
    // and drives it forward with a REALISTIC per-call time budget, exactly
    // the way server.js's assembleAndStoreFinalVideo does in production —
    // proving completion happens across multiple bounded calls, with no
    // single call anywhere close to a real serverless timeout, rather than
    // needing one long-lived request.
    const { srt, totalSeconds } = buildLongSrt(96, 9, 1);
    const audioPath = await makeToneAudio(workDir, totalSeconds, 'e2e');
    const REALISTIC_PER_CALL_BUDGET_MS = 15000; // generous but far under any real platform limit

    let render;
    let result;
    let callCount = 0;
    do {
      callCount++;
      const callStart = Date.now();
      result = await ssv.continueSimpleStoryVideoAssembly({
        voiceover: { status: 'completed', url: audioPath },
        subtitlesContent: srt,
        existingRender: render,
        jobId: 'test-job-e2e-production-shape',
        timeBudgetMs: REALISTIC_PER_CALL_BUDGET_MS,
      });
      render = result.render;
      const callElapsedMs = Date.now() - callStart;
      assert.ok(
        callElapsedMs < REALISTIC_PER_CALL_BUDGET_MS + 10000,
        `call ${callCount} took ${callElapsedMs}ms — a single call must never run drastically longer than its own time budget`
      );
      assert.ok(callCount <= 20, 'test setup: this should resolve well within 20 calls, or something regressed badly');
    } while (result.status === 'in_progress');

    assert.strictEqual(result.status, 'completed', result.error);
    assert.ok(callCount > 1, 'test setup: this job must genuinely need more than one call, or this test proves nothing about resumability');
    assert.ok(render.sections.every((section) => section.status === 'completed'));
    assert.ok(result.buffer && result.buffer.length > 0);

    const outPath = path.join(workDir, 'output-e2e.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);
    assert.strictEqual(probed.width, ssv.SIMPLE_STORY_WIDTH);
    assert.strictEqual(probed.height, ssv.SIMPLE_STORY_HEIGHT);
    assert.ok(Math.abs(probed.duration - totalSeconds) < 0.5, `expected ~${totalSeconds.toFixed(1)}s duration, got ${probed.duration}`);
  });

  // --- Selective video editing (videoEditSettings) ---

  await test('normalizeVideoEditSettings returns the all-defaults shape for missing/empty input', () => {
    for (const input of [undefined, null, {}, 'not an object']) {
      assert.deepStrictEqual(ssv.normalizeVideoEditSettings(input), {
        backgroundColor: null,
        storyPosition: null,
        fontWeight: null,
        subtitleFontScale: 1,
        subtitleColor: null,
        subtitleTimingOffsetMs: 0,
        voiceSpeed: 1,
        voiceVolumeDb: 0,
      });
    }
  });

  await test('normalizeVideoEditSettings accepts valid values and lowercases hex colors', () => {
    const normalized = ssv.normalizeVideoEditSettings({
      backgroundColor: '1A2B3C',
      storyPosition: 'top',
      fontWeight: 'bold',
      subtitleFontScale: 1.5,
      subtitleColor: 'FF0000',
      subtitleTimingOffsetMs: 250,
      voiceSpeed: 1.25,
      voiceVolumeDb: 6,
    });
    assert.deepStrictEqual(normalized, {
      backgroundColor: '1a2b3c',
      storyPosition: 'top',
      fontWeight: 'bold',
      subtitleFontScale: 1.5,
      subtitleColor: 'ff0000',
      subtitleTimingOffsetMs: 250,
      voiceSpeed: 1.25,
      voiceVolumeDb: 6,
    });
  });

  await test('normalizeVideoEditSettings clamps out-of-range numbers and rejects invalid enums/hex', () => {
    const normalized = ssv.normalizeVideoEditSettings({
      backgroundColor: 'not-a-color',
      storyPosition: 'sideways',
      fontWeight: 'italic',
      subtitleFontScale: 999,
      subtitleColor: '12345', // one digit short
      subtitleTimingOffsetMs: -999999,
      voiceSpeed: 10,
      voiceVolumeDb: -999,
    });
    assert.strictEqual(normalized.backgroundColor, null);
    assert.strictEqual(normalized.storyPosition, null);
    assert.strictEqual(normalized.fontWeight, null);
    assert.strictEqual(normalized.subtitleFontScale, ssv.SUBTITLE_FONT_SCALE_MAX);
    assert.strictEqual(normalized.subtitleColor, null);
    assert.strictEqual(normalized.subtitleTimingOffsetMs, ssv.SUBTITLE_TIMING_OFFSET_MS_MIN);
    assert.strictEqual(normalized.voiceSpeed, ssv.VOICE_SPEED_MAX);
    assert.strictEqual(normalized.voiceVolumeDb, ssv.VOICE_VOLUME_DB_MIN);
  });

  await test('normalizeVideoEditSettings is pure — the same input always JSON-serializes identically', () => {
    const input = { backgroundColor: '2d3142', voiceSpeed: 1.1 };
    const a = JSON.stringify(ssv.normalizeVideoEditSettings(input));
    const b = JSON.stringify(ssv.normalizeVideoEditSettings({ ...input }));
    assert.strictEqual(a, b);
  });

  await test('applyCueTimingAdjustments returns the SAME array reference when speed=1 and offset=0', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const result = ssv.applyCueTimingAdjustments(cues, ssv.normalizeVideoEditSettings({}));
    assert.strictEqual(result, cues);
  });

  await test('applyCueTimingAdjustments rescales every timestamp by voiceSpeed', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const adjusted = ssv.applyCueTimingAdjustments(cues, ssv.normalizeVideoEditSettings({ voiceSpeed: 2 }));
    assert.strictEqual(adjusted.length, cues.length);
    for (let i = 0; i < cues.length; i++) {
      assert.ok(Math.abs(adjusted[i].start - cues[i].start / 2) < 1e-9);
      assert.ok(Math.abs(adjusted[i].end - cues[i].end / 2) < 1e-9);
    }
  });

  await test('applyCueTimingAdjustments shifts every timestamp by subtitleTimingOffsetMs, independent of speed', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const adjusted = ssv.applyCueTimingAdjustments(cues, ssv.normalizeVideoEditSettings({ subtitleTimingOffsetMs: 500 }));
    for (let i = 0; i < cues.length; i++) {
      assert.ok(Math.abs(adjusted[i].start - (cues[i].start + 0.5)) < 1e-9);
      assert.ok(Math.abs(adjusted[i].end - (cues[i].end + 0.5)) < 1e-9);
    }
  });

  await test('applyCueTimingAdjustments drops a cue a large negative offset would push entirely before zero', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT); // first cue: 0 -> 2.5
    const adjusted = ssv.applyCueTimingAdjustments(cues, ssv.normalizeVideoEditSettings({ subtitleTimingOffsetMs: -10000 }));
    assert.ok(adjusted.length < cues.length, 'a cue clamped to start === end (or negative) must be dropped, not shown backwards');
  });

  await test('buildAssScript with default editSettings is byte-identical to omitting the argument', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const withDefaults = ssv.buildAssScript(cues, 10, ssv.normalizeVideoEditSettings({}));
    const withoutArg = ssv.buildAssScript(cues, 10);
    assert.strictEqual(withDefaults, withoutArg);
  });

  await test('buildAssScript applies storyPosition/fontWeight/subtitleFontScale/subtitleColor to the ASS style rows', () => {
    const cues = ssv.parseSrt(FIXTURE_SRT);
    const edited = ssv.buildAssScript(
      cues,
      10,
      ssv.normalizeVideoEditSettings({
        storyPosition: 'top',
        fontWeight: 'regular',
        subtitleFontScale: 2,
        subtitleColor: 'ff0000',
      })
    );

    const storyLine = edited.split('\n').find((line) => line.startsWith('Style: Story,'));
    const captionLine = edited.split('\n').find((line) => line.startsWith('Style: Caption,'));
    const storyFields = storyLine.split(',');
    const captionFields = captionLine.split(',');

    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
    // OutlineColour, BackColour, Bold, ..., Alignment, MarginL, MarginR, MarginV, Encoding
    assert.strictEqual(storyFields[2], '128', 'story fontsize must be 64 * subtitleFontScale(2)');
    assert.strictEqual(storyFields[3], ssv.assColorFromHex('ff0000'), 'story PrimaryColour must reflect subtitleColor');
    assert.strictEqual(storyFields[7], '0', 'fontWeight "regular" must turn story Bold off');
    assert.strictEqual(storyFields[18], '8', 'storyPosition "top" must set Story Alignment to 8');

    // The caption line always stays bottom-center regardless of
    // storyPosition — only its fontsize/color/weight follow editSettings.
    assert.strictEqual(captionFields[2], '60', 'caption fontsize must be 30 * subtitleFontScale(2)');
    assert.strictEqual(captionFields[3], ssv.assColorFromHex('ff0000'));
    assert.strictEqual(captionFields[18], '2', 'the caption line must always stay bottom-center (Alignment 2)');
  });

  await test('assColorFromHex converts RRGGBB to ASS &H00BBGGRR and falls back to white for invalid input', () => {
    assert.strictEqual(ssv.assColorFromHex('ffffff'), '&H00FFFFFF');
    assert.strictEqual(ssv.assColorFromHex('ff0000'), '&H000000FF');
    assert.strictEqual(ssv.assColorFromHex('00ff00'), '&H0000FF00');
    assert.strictEqual(ssv.assColorFromHex('not-a-color'), '&H00FFFFFF');
  });

  await test('prepareEffectiveAudio returns the source path UNCHANGED when voiceSpeed=1 and voiceVolumeDb=0', async () => {
    const audioPath = await makeToneAudio(workDir, 3, 'no-edit');
    const result = await ssv.prepareEffectiveAudio(audioPath, ssv.normalizeVideoEditSettings({}), workDir);
    assert.strictEqual(result, audioPath);
  });

  await test('prepareEffectiveAudio applies voiceSpeed locally, producing real audio at the new duration', async () => {
    const audioPath = await makeToneAudio(workDir, 10, 'speed-edit');
    const edited = await ssv.prepareEffectiveAudio(audioPath, ssv.normalizeVideoEditSettings({ voiceSpeed: 2 }), workDir);
    assert.notStrictEqual(edited, audioPath);
    const duration = await probeAudioDuration(edited);
    assert.ok(Math.abs(duration - 5) < 0.3, `expected ~5s (10s / 2x speed), got ${duration}`);
  });

  await test('prepareEffectiveAudio applies voiceVolumeDb locally without changing duration', async () => {
    const audioPath = await makeToneAudio(workDir, 4, 'volume-edit');
    const originalDuration = await probeAudioDuration(audioPath);
    const edited = await ssv.prepareEffectiveAudio(audioPath, ssv.normalizeVideoEditSettings({ voiceVolumeDb: -6 }), workDir);
    assert.notStrictEqual(edited, audioPath);
    const editedDuration = await probeAudioDuration(edited);
    assert.ok(Math.abs(editedDuration - originalDuration) < 0.3);
  });

  await test('continueSimpleStoryVideoAssembly renders a real solid backgroundColor override into the actual pixels', async () => {
    const audioPath = await makeToneAudio(workDir, 4, 'bg-color');
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: null,
      jobId: 'test-job-bg-color',
      editSettings: { backgroundColor: '204080' },
    });
    assert.strictEqual(result.status, 'completed', result.error);

    const outPath = path.join(workDir, 'output-bg-color.mp4');
    fs.writeFileSync(outPath, result.buffer);
    // Top-left corner, well after the fade-in, is plain background — away
    // from the centered story text box and the bottom caption line.
    const pixel = await probePixelColor(outPath, 1.5, 10, 10);
    assert.ok(Math.abs(pixel.r - 0x20) <= 20, `expected R≈0x20, got 0x${pixel.r.toString(16)}`);
    assert.ok(Math.abs(pixel.g - 0x40) <= 20, `expected G≈0x40, got 0x${pixel.g.toString(16)}`);
    assert.ok(Math.abs(pixel.b - 0x80) <= 20, `expected B≈0x80, got 0x${pixel.b.toString(16)}`);
  });

  await test('continueSimpleStoryVideoAssembly applies voiceSpeed to both the audio and the on-screen text timing', async () => {
    const audioPath = await makeToneAudio(workDir, 12, 'speed-e2e');
    const originalDuration = await probeAudioDuration(audioPath);
    const result = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: null,
      jobId: 'test-job-speed-e2e',
      editSettings: { voiceSpeed: 2 },
    });
    assert.strictEqual(result.status, 'completed', result.error);

    const outPath = path.join(workDir, 'output-speed-e2e.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);
    assert.ok(
      Math.abs(probed.duration - originalDuration / 2) < 0.5,
      `expected ~${(originalDuration / 2).toFixed(1)}s (half the original ${originalDuration.toFixed(1)}s), got ${probed.duration}`
    );
  });

  await test('continueSimpleStoryVideoAssembly discards and fully re-renders every section when ONLY videoEditSettings changes', async () => {
    const audioPath = await makeToneAudio(workDir, 4, 'edit-staleness');
    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: null,
      jobId: 'test-job-edit-staleness',
    });
    assert.strictEqual(first.status, 'completed', first.error);
    const firstUrls = first.render.sections.map((s) => s.url);

    // Same exact voice-over/subtitles — only a videoEditSettings change.
    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: first.render,
      jobId: 'test-job-edit-staleness',
      editSettings: { backgroundColor: '112233' },
    });
    assert.strictEqual(second.status, 'completed', second.error);
    const secondUrls = second.render.sections.map((s) => s.url);

    assert.strictEqual(secondUrls.length, firstUrls.length);
    for (let i = 0; i < firstUrls.length; i++) {
      assert.notStrictEqual(secondUrls[i], firstUrls[i], `section ${i} must be genuinely re-rendered after an editSettings change`);
    }
    assert.strictEqual(second.render.editSettingsSnapshot, JSON.stringify(ssv.normalizeVideoEditSettings({ backgroundColor: '112233' })));
  });

  await test('continueSimpleStoryVideoAssembly is a no-op re-render (same section urls) when editSettings are unchanged', async () => {
    const audioPath = await makeToneAudio(workDir, 4, 'edit-idempotent');
    const editSettings = { backgroundColor: '445566' };
    const first = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: null,
      jobId: 'test-job-edit-idempotent',
      editSettings,
    });
    assert.strictEqual(first.status, 'completed', first.error);

    const second = await ssv.continueSimpleStoryVideoAssembly({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      existingRender: first.render,
      jobId: 'test-job-edit-idempotent',
      editSettings,
    });
    assert.strictEqual(second.status, 'completed', second.error);

    assert.deepStrictEqual(
      second.render.sections.map((s) => s.url),
      first.render.sections.map((s) => s.url),
      'identical editSettings must never trigger a wasted re-render'
    );
  });

  fs.rmSync(workDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll simple-story-video tests passed.');
  }
}

main();
