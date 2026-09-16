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

function makeToneAudio(dir, seconds) {
  const outPath = path.join(dir, `tone-${seconds}.mp3`);
  return runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-c:a', 'libmp3lame', outPath]).then(
    () => outPath
  );
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

  await test('assembleSimpleStoryVideo refuses without a completed voice-over', async () => {
    const result = await ssv.assembleSimpleStoryVideo({
      voiceover: { status: 'pending', url: null },
      subtitlesContent: FIXTURE_SRT,
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(/voice-over/i.test(result.error));
    assert.strictEqual(result.buffer, null);
  });

  await test('assembleSimpleStoryVideo refuses without real subtitles content', async () => {
    const audioPath = await makeToneAudio(workDir, 9);
    const result = await ssv.assembleSimpleStoryVideo({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: '',
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(/subtitles/i.test(result.error));
  });

  await test('assembleSimpleStoryVideo produces a real 1920x1080 MP4 with genuine audio, matching the real audio duration', async () => {
    const audioPath = await makeToneAudio(workDir, 9);
    const result = await ssv.assembleSimpleStoryVideo({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      sectionTargetSeconds: 3, // forces multiple real sections/transitions from this short fixture
    });

    assert.strictEqual(result.status, 'completed', result.error);
    assert.ok(result.buffer && result.buffer.length > 0);

    const outPath = path.join(workDir, 'output.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);

    assert.strictEqual(probed.width, ssv.SIMPLE_STORY_WIDTH);
    assert.strictEqual(probed.height, ssv.SIMPLE_STORY_HEIGHT);
    assert.ok(Math.abs(probed.duration - 9) < 0.3, `expected ~9s duration, got ${probed.duration}`);
  });

  await test('assembleSimpleStoryVideo pads the video to the real audio duration when cues end early', async () => {
    // Audio runs 12s but the fixture's last cue ends at 8.9s — the video
    // must never truncate real narration; it should hold the last frame
    // for the remaining ~3.1s instead.
    const audioPath = await makeToneAudio(workDir, 12);
    const result = await ssv.assembleSimpleStoryVideo({
      voiceover: { status: 'completed', url: audioPath },
      subtitlesContent: FIXTURE_SRT,
      sectionTargetSeconds: 3,
    });

    assert.strictEqual(result.status, 'completed', result.error);
    const outPath = path.join(workDir, 'output-padded.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = await probe(outPath);
    assert.ok(Math.abs(probed.duration - 12) < 0.3, `expected the video to be padded out to ~12s, got ${probed.duration}`);
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
