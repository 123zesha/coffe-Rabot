// Assembles the "Simple Story Video" mode's final MP4 — a local,
// FFmpeg-only alternative to backend/video-assembly.js's Runway-clip
// assembly, built for English learning/listening-practice story videos.
// This module makes NO calls to Runway, OpenAI, or any other paid API: its
// only real inputs are a job's ALREADY-generated voice-over audio and
// ALREADY-generated subtitles (both paid for earlier, exactly once, by the
// existing voiceover-generation.js/subtitles-generation.js steps this mode
// still uses unmodified) — turning them into video is pure local ffmpeg
// media processing, identical in spirit to video-assembly.js's own "this
// step calls no paid API" guarantee.
//
// Design: subtitles.content (a real .srt, transcribed from THIS job's own
// voice-over audio — never guessed) is the single source of truth for both
// what text appears on screen AND when, because it is the only real,
// measured timing this app has for the narration.
//
// Text rendering deliberately does NOT use ffmpeg's `drawtext` filter —
// verified empirically against the exact ffmpeg binary this project bundles
// (backend/node_modules/ffmpeg-static): this static build was compiled
// WITHOUT drawtext (`ffmpeg -filters` does not list it, and attempting to
// use it fails with "No such filter: 'drawtext'"), even though the
// underlying freetype/fontconfig libraries are present. It DOES include
// `subtitles`/`ass` (libass) and `zoompan`, so both the large on-screen
// story text and the small caption line are rendered as ASS subtitle
// events — two styles (large centered "Story" text, small bottom
// "Caption" text) burned in via a single `ass=` filter pass. This gives
// equivalent control (position, box background, font) to drawtext while
// only using filters this exact bundled ffmpeg build actually supports.
//
// Cues are grouped into "sections" by real elapsed time (never a fixed cue
// count, so pacing stays even regardless of sentence length) — each
// section gets its own simple solid-color background, a slow Ken Burns
// zoom, AND its own slice of the on-screen story/caption text burned in,
// all in one ffmpeg pass per section (see renderSection), then concatenated
// with a short fade-to-black transition at each boundary. Text used to be
// burned in globally, once, over the fully concatenated timeline — moved
// per-section (each section's cues localized to its own 0-based timeline
// by cuesForSection) so that work runs inside the same parallel step as
// the background rendering, and concatenation never needs to re-encode
// anything afterward regardless of the video's total length.
//
// Every text-rendering filter references a font BUNDLED with this repo
// (assets/fonts/) via an explicit fontsdir path, rather than depending on
// the deployment environment happening to have any system fonts installed
// — the same "ffmpeg-static bundles a real binary so production doesn't
// depend on a system package" reasoning this project already applies to
// ffmpeg itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { ffmpegPath, getMediaDuration } = require('./video-assembly');
const videoStorage = require('./video-storage');

const FONTS_DIR = path.resolve(__dirname, '..', 'assets', 'fonts');
const FONT_BOLD_PATH = path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf');
const FONT_REGULAR_PATH = path.join(FONTS_DIR, 'DejaVuSans.ttf');
// Must match the font's own internal family name (what libass looks up in
// fontsdir), not the file name — DejaVu Sans's bold weight is the same
// family name with a separate Bold-flagged file, which is how both
// DejaVuSans.ttf and DejaVuSans-Bold.ttf coexist under one family below.
const FONT_FAMILY = 'DejaVu Sans';

// Fixed per the Simple Story Video mode's own requirements — unlike the
// Runway pipeline's outputFormat/resolutionTier, this mode always renders
// horizontal 16:9 at 1080p; there is nothing to vary it against (no scene
// images/clips whose own generation canvas this would need to match).
const SIMPLE_STORY_WIDTH = 1920;
const SIMPLE_STORY_HEIGHT = 1080;
// A modest frame rate keeps encode time reasonable for a long (15-20
// minute) video — there is no fast motion here that would benefit from a
// higher rate; every visible movement is a slow Ken Burns drift.
const SIMPLE_STORY_FPS = 24;

// How much real narration time each section covers before a new
// background/Ken-Burns section begins — this is what "break long stories
// into manageable sections automatically" means here: a purely mechanical
// split driven by real cue timestamps, not a separate LLM call. Overridable
// (this module's own tests use a much smaller value so a short fixture
// still exercises multiple real sections/transitions).
const DEFAULT_SECTION_TARGET_SECONDS = 45;

const SECTION_FADE_SECONDS = 0.4;

// 'ultrafast', not 'veryfast': real Vercel production logs (added via the
// phase-timing diagnostic above) showed each section — a plain solid-color
// background with a slow Ken Burns zoom and burned-in text — taking
// roughly 25s to encode in production, dramatically slower than the ~2-5s
// this same encode took locally. Measured directly against the exact
// filter chain this module uses (zoompan+fade+ass, 1920x1080, 45s), 'ultrafast'
// encodes in about half the time 'veryfast' does for this content. Content
// here is simple by design (a solid color and a slow zoom, never real
// footage), so 'ultrafast'-vs-'veryfast' compression efficiency — the
// tradeoff that normally matters for this preset choice — is not a
// meaningful concern; output file size stays small either way.
const SECTION_ENCODE_PRESET = 'ultrafast';

// A short rotation of plain, high-contrast-with-white-text colors — "simple
// clean backgrounds" is implemented literally: a solid color, never a
// generated/fetched image, so this mode never depends on any image
// provider either. Hex values (no '#') for ffmpeg's color= source.
const SECTION_BACKGROUND_COLORS = ['1e293b', '0f4c4c', '2d3142', '14532d', '3f3d56', '4a2545', '1f2937', '3d2645'];

function backgroundColorForSection(sectionIndex) {
  return SECTION_BACKGROUND_COLORS[sectionIndex % SECTION_BACKGROUND_COLORS.length];
}

// --- Selective, local-only video editing (videoEditSettings) ---
//
// Lets a user request ONE targeted visual/audio change after a video
// already exists — "make the background navy", "slow the voice-over down",
// "shift the captions earlier" — without regenerating the script, voice-
// over, subtitles, images, or thumbnail, and without any paid API call.
// See job-store.js's videoEditSettings field comment for the full field
// list and defaults; everything below only ever reads the NORMALIZED shape
// normalizeVideoEditSettings produces, never raw/unvalidated agent input.
const HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;
const VALID_STORY_POSITIONS = ['top', 'center', 'bottom'];
const VALID_FONT_WEIGHTS = ['regular', 'bold'];
// ffmpeg's atempo filter only accepts a single-instance range of
// [0.5, 2.0] — outside that it must be chained across multiple atempo
// calls, which this app deliberately never needs by clamping here instead.
const VOICE_SPEED_MIN = 0.5;
const VOICE_SPEED_MAX = 2.0;
const VOICE_VOLUME_DB_MIN = -30;
const VOICE_VOLUME_DB_MAX = 30;
const SUBTITLE_FONT_SCALE_MIN = 0.5;
const SUBTITLE_FONT_SCALE_MAX = 2.0;
const SUBTITLE_TIMING_OFFSET_MS_MIN = -10000;
const SUBTITLE_TIMING_OFFSET_MS_MAX = 10000;

function clampNumber(value, min, max, fallback, isInteger) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, num));
  return isInteger ? Math.round(clamped) : clamped;
}

// Turns arbitrary (possibly missing/invalid) edit-setting input into a
// canonical, safe-to-use shape — every field either a validated value or
// this feature's own "use the existing built-in default" value (never
// null for the numeric fields, so callers can use them directly in ffmpeg
// filter strings/ASS style rows with no further checking). Called on every
// continueSimpleStoryVideoAssembly invocation, and the result is what gets
// JSON-serialized into the render progress ledger's editSettingsSnapshot —
// so this must be a pure function of its input (same input, same output)
// for that staleness check to mean anything.
function normalizeVideoEditSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    backgroundColor: HEX_COLOR_RE.test(input.backgroundColor || '') ? input.backgroundColor.toLowerCase() : null,
    storyPosition: VALID_STORY_POSITIONS.includes(input.storyPosition) ? input.storyPosition : null,
    fontWeight: VALID_FONT_WEIGHTS.includes(input.fontWeight) ? input.fontWeight : null,
    subtitleFontScale: clampNumber(input.subtitleFontScale, SUBTITLE_FONT_SCALE_MIN, SUBTITLE_FONT_SCALE_MAX, 1),
    subtitleColor: HEX_COLOR_RE.test(input.subtitleColor || '') ? input.subtitleColor.toLowerCase() : null,
    subtitleTimingOffsetMs: clampNumber(
      input.subtitleTimingOffsetMs,
      SUBTITLE_TIMING_OFFSET_MS_MIN,
      SUBTITLE_TIMING_OFFSET_MS_MAX,
      0,
      true
    ),
    voiceSpeed: clampNumber(input.voiceSpeed, VOICE_SPEED_MIN, VOICE_SPEED_MAX, 1),
    voiceVolumeDb: clampNumber(input.voiceVolumeDb, VOICE_VOLUME_DB_MIN, VOICE_VOLUME_DB_MAX, 0),
  };
}

// Converts a plain 'RRGGBB' hex string into ASS's own `&HAABBGGRR` color
// format (alpha 00 = fully opaque here, matching every hardcoded color
// buildAssScript already used before this feature existed). Falls back to
// opaque white for anything that isn't a real 6-digit hex string, so a bad
// value here can never break the ffmpeg ass= filter.
function assColorFromHex(hex) {
  const clean = HEX_COLOR_RE.test(hex || '') ? hex : 'ffffff';
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

// Rescales/shifts real transcribed cue timestamps to match a LOCALLY sped-
// up/slowed-down copy of the voice-over audio (see prepareEffectiveAudio) —
// never the audio's own real content, which is never re-transcribed just
// for a speed change. voiceSpeed > 1 plays the audio faster (shorter
// duration), so every cue's timestamp is divided by the same factor to
// land at the same relative moment in the new, shorter timeline;
// subtitleTimingOffsetMs then applies a further fixed shift for a pure
// resync, independent of any speed change. Returns the SAME array
// reference when neither setting differs from its default, so a job with
// no voice/timing edits pays zero extra allocation. Never returns cues with
// end <= start (a large enough negative offset could otherwise push a cue
// entirely before zero) — those are dropped rather than shown backwards.
function applyCueTimingAdjustments(cues, editSettings) {
  const speed = editSettings && editSettings.voiceSpeed > 0 ? editSettings.voiceSpeed : 1;
  const offsetSeconds = editSettings && Number.isFinite(editSettings.subtitleTimingOffsetMs) ? editSettings.subtitleTimingOffsetMs / 1000 : 0;
  if (speed === 1 && offsetSeconds === 0) {
    return cues;
  }

  return cues
    .map((cue) => ({
      start: Math.max(0, cue.start / speed + offsetSeconds),
      end: Math.max(0, cue.end / speed + offsetSeconds),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start);
}

// Applies voiceSpeed/voiceVolumeDb to the job's ALREADY-generated voice-
// over audio, entirely locally via ffmpeg's atempo/volume filters — never a
// new text-to-speech call, per this feature's own "never regenerate a
// paid-for asset just to make one targeted edit" rule. Returns sourcePath
// UNCHANGED (no ffmpeg call at all) when both settings are at their
// defaults, so a job with no voice edits never pays this extra cost.
async function prepareEffectiveAudio(sourcePath, editSettings, workDir) {
  const speed = editSettings.voiceSpeed;
  const volumeDb = editSettings.voiceVolumeDb;
  if (speed === 1 && volumeDb === 0) {
    return sourcePath;
  }

  const filters = [];
  if (speed !== 1) {
    filters.push(`atempo=${speed}`);
  }
  if (volumeDb !== 0) {
    filters.push(`volume=${volumeDb}dB`);
  }

  const outPath = path.join(workDir, 'voiceover-audio-edited.m4a');
  await runFfmpeg(['-y', '-i', sourcePath, '-filter:a', filters.join(','), '-c:a', 'aac', outPath]);
  return outPath;
}

// How many section renders (see renderSection below) run at once. Each one
// spawns its own independent ffmpeg process on its own output file — there
// is no shared state between them — so they were previously run ONE AT A
// TIME in a for-loop purely by omission, not because they depend on each
// other. A real 15-20 minute story at the default 45s section target
// produces 20+ sections; awaiting each one's process-spawn-plus-encode
// sequentially was measured to be the dominant real cause of a production
// job exceeding Vercel's 300s function timeout on POST /api/agent (a real
// "Vercel Runtime Timeout Error: Task timed out after 300 seconds"), not
// the single final combined encode pass (already optimized — see its own
// comment below). Bounded, not unbounded like voiceover-generation.js's
// chunk concurrency, because section count here can run much higher (20+
// vs. a handful of TTS chunks) and each is a real ffmpeg child process —
// an unbounded burst risks contending for the same limited CPU/memory a
// serverless function has, which could make things worse instead of
// better. This changes ONLY the scheduling of independent work; the
// output bytes are unaffected — same sections, same settings, same order.
const SECTION_RENDER_CONCURRENCY = 4;

// How long, at most, continueSimpleStoryVideoAssembly spends STARTING new
// section renders in one call before returning progress-so-far instead of
// continuing to completion — real production evidence (Vercel's own "Task
// timed out after 300 seconds" logs, cross-referenced against this
// module's own phase-timing log lines) showed section rendering alone can
// still be in progress well past 300s for a long story. This leaves a real
// margin below that platform limit for the audio download, whatever
// sections are already in flight to finish, their storage uploads, and the
// HTTP response itself. Already-started sections always finish (never
// aborted mid-encode) — this only stops STARTING new ones once the budget
// is spent, which is what makes each invocation's own wall-clock time
// predictable regardless of how many sections remain.
const RENDER_TIME_BUDGET_MS = 200000;

// Runs `mapper` over `items` with at most `limit` calls in flight at once,
// resolving to results in the SAME ORDER as `items` regardless of which
// call finishes first — required here because sectionPaths must stay in
// story order for the concat step below. A rejection from any call rejects
// the whole call, same as Promise.all.
//
// `deadlineAt` (a Date.now()-comparable timestamp, or null/undefined for no
// deadline) stops STARTING new work once passed, letting anything already
// in flight finish — always starts at least one item per worker slot
// first, so a deadline that has already passed on entry still makes real
// forward progress instead of doing nothing. `results[i]` stays undefined
// for any item never started; the caller tells those apart from real
// results by index, the same way it knows items[i] was never processed.
async function mapWithConcurrencyUntilDeadline(items, limit, deadlineAt, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let startedCount = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (startedCount > 0 && deadlineAt && Date.now() >= deadlineAt) {
        return;
      }
      const currentIndex = nextIndex++;
      startedCount++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || '').toString().trim().slice(-2000);
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

// ffmpeg filter option VALUES need `:`, `'`, and `\` escaped — our own
// paths (repo/tmpdir-based, no user input) never actually contain these,
// but escaping defensively costs nothing and matches this codebase's
// existing care around ffmpeg filter strings (see video-assembly.js).
function escapeFilterValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function srtTimestampToSeconds(raw) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid SRT timestamp: "${raw}"`);
  }
  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

// Parses real .srt text (as produced by backend/subtitles-generation.js's
// real transcription of this job's own voice-over — never estimated from
// the script) into { start, end, text } cues, sorted by start time. Cues
// with no real text are dropped rather than shown as a blank on-screen
// line.
function parseSrt(srtText) {
  const blocks = String(srtText || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex === -1) {
      continue;
    }

    const [startRaw, endRaw] = lines[timeLineIndex].split('-->');
    const start = srtTimestampToSeconds(startRaw);
    const end = srtTimestampToSeconds(endRaw);
    const text = lines
      .slice(timeLineIndex + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && end > start) {
      cues.push({ start, end, text });
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

// Groups cues into { start, end } sections purely to drive the background/
// Ken-Burns visual timeline: a new section starts whenever the running
// section would otherwise exceed sectionTargetSeconds — never mid-cue, and
// never by a fixed cue count. `end` is the next section's start (or
// totalDuration for the last one).
function groupCuesIntoSections(cues, sectionTargetSeconds, totalDuration) {
  if (!Array.isArray(cues) || cues.length === 0) {
    return [];
  }

  const starts = [cues[0].start];
  let sectionStart = cues[0].start;
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start - sectionStart >= sectionTargetSeconds) {
      starts.push(cues[i].start);
      sectionStart = cues[i].start;
    }
  }

  return starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] : Math.max(totalDuration, cues[cues.length - 1].end),
  }));
}

// Greedily wraps `text` to at most maxCharsPerLine per line. If the result
// still exceeds maxLines, the overflow is merged onto the last line rather
// than dropped — real narration text is never truncated to fit a layout.
function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).join(' ');
    return [...head, tail];
  }

  return lines;
}

// Picks a font size (trying large first) that keeps a cue's wrapped text to
// a readable number of lines, and returns the wrapped lines alongside it.
// Never fails — an unusually long single cue just ends up at the smallest
// size with its lines merged, same honesty-over-truncation rule as
// wrapText itself.
function fitCueText(text) {
  const candidates = [
    { fontSize: 72, maxLines: 3 },
    { fontSize: 56, maxLines: 4 },
    { fontSize: 44, maxLines: 5 },
  ];

  for (const { fontSize, maxLines } of candidates) {
    const maxCharsPerLine = Math.floor((SIMPLE_STORY_WIDTH * 0.82) / (fontSize * 0.56));
    const lines = wrapText(text, maxCharsPerLine, maxLines);
    if (lines.length <= maxLines) {
      return { fontSize, lines };
    }
  }

  const smallest = candidates[candidates.length - 1];
  const maxCharsPerLine = Math.floor((SIMPLE_STORY_WIDTH * 0.82) / (smallest.fontSize * 0.56));
  return { fontSize: smallest.fontSize, lines: wrapText(text, maxCharsPerLine, smallest.maxLines) };
}

function secondsToAssTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const centiseconds = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

// ASS Dialogue text uses `{}` for override tags and `\N`/`\n` for line
// breaks — real narration text could coincidentally contain literal braces
// (never `\`, which JS string content from a script/transcription would
// only contain if the source text itself did). Braces are escaped to a
// visually similar full-width form rather than stripped, so nothing about
// the actual narration text is silently dropped.
function escapeAssText(text) {
  return String(text).replace(/\{/g, '\uFF5B').replace(/\}/g, '\uFF5D');
}

// Builds one ASS script covering a given span of the video (the whole
// video, or — see renderSection — just one section's own local timeline):
// a large, centered "Story" line per cue (held on screen until the NEXT
// cue begins, so a natural pause never blanks the screen — extending to
// `audioDuration`, the span's own real end, for the last cue) and a small,
// bottom "Caption" line per cue at its own original transcribed timing
// (standard caption behavior). Both draw from the exact same real,
// transcribed cues — never two different sources of truth for the same
// narration.
// editSettings: an ALREADY-NORMALIZED videoEditSettings shape (see
// normalizeVideoEditSettings) — omitted/defaulted fields reproduce the
// exact original hardcoded look byte-for-byte (large bold white centered
// story text, small regular white bottom caption text), so a job that
// never touches this feature renders exactly as before it existed. Only
// storyPosition moves the on-screen story text (top/center/bottom); the
// caption line always stays at the bottom, standard subtitle placement.
function buildAssScript(cues, audioDuration, editSettings = {}) {
  const storyPosition = VALID_STORY_POSITIONS.includes(editSettings.storyPosition) ? editSettings.storyPosition : 'center';
  const fontWeight = VALID_FONT_WEIGHTS.includes(editSettings.fontWeight) ? editSettings.fontWeight : null;
  const subtitleFontScale = editSettings.subtitleFontScale > 0 ? editSettings.subtitleFontScale : 1;
  const textColorAss = assColorFromHex(editSettings.subtitleColor);

  const storyBold = fontWeight === 'regular' ? 0 : 1;
  const captionBold = fontWeight === 'bold' ? 1 : 0;
  const storyAlignment = storyPosition === 'top' ? 8 : storyPosition === 'bottom' ? 2 : 5;
  const storyMarginV = storyPosition === 'center' ? 0 : 60;
  const storyFontSize = Math.round(64 * subtitleFontScale);
  const captionFontSize = Math.round(30 * subtitleFontScale);

  const header =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${SIMPLE_STORY_WIDTH}\n` +
    `PlayResY: ${SIMPLE_STORY_HEIGHT}\n` +
    'WrapStyle: 2\n' +
    'ScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
    'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
    'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    // Story: large, centered by default (Alignment 5 = middle-center; see
    // storyPosition above), an opaque box background (BorderStyle 3) for
    // readability over any background color.
    `Style: Story,${FONT_FAMILY},${storyFontSize},${textColorAss},${textColorAss},&H00000000,&H99000000,${storyBold},0,0,0,100,100,0,0,3,0,4,${storyAlignment},120,120,${storyMarginV},1\n` +
    // Caption: small, always bottom-center (Alignment 2), plain outline (no
    // box) — the familiar closed-caption look, mirroring what
    // burnInSubtitles already produces elsewhere in this app.
    `Style: Caption,${FONT_FAMILY},${captionFontSize},${textColorAss},${textColorAss},&H00000000,&H00000000,${captionBold},0,0,0,100,100,0,0,1,2,0,2,40,40,48,1\n\n` +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  const lines = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const nextCue = cues[i + 1];
    const storyEnd = nextCue ? nextCue.start : audioDuration;
    const { lines: wrapped } = fitCueText(cue.text);
    const storyText = wrapped.map(escapeAssText).join('\\N');

    lines.push(
      `Dialogue: 0,${secondsToAssTimestamp(cue.start)},${secondsToAssTimestamp(Math.max(storyEnd, cue.start + 0.1))},Story,,0,0,0,,${storyText}`
    );
    lines.push(
      `Dialogue: 0,${secondsToAssTimestamp(cue.start)},${secondsToAssTimestamp(cue.end)},Caption,,0,0,0,,${escapeAssText(cue.text)}`
    );
  }

  return header + lines.join('\n') + '\n';
}

// Returns the cues that fall in this section (matched by real, GLOBAL
// cue.start), with start/end shifted to the section's own LOCAL timeline
// (0 = section.start) — ready to pass straight into buildAssScript.
// groupCuesIntoSections only ever starts a new section exactly at some
// cue's own start time, so a cue's "hold text until the next cue begins"
// span (see buildAssScript) can never actually need to reach past its own
// section's end: the next cue either falls in this SAME section, or IS the
// cue whose start defines the following section's boundary. Per-section
// text burn-in is therefore byte-identical in timing to the original
// single global pass, not an approximation. A cue's own real end is
// clamped to the section's end as a defensive safety net (real transcribed
// cues are sequential and this should not trigger in practice).
function cuesForSection(cues, section) {
  return cues
    .filter((cue) => cue.start >= section.start && cue.start < section.end)
    .map((cue) => ({
      start: cue.start - section.start,
      end: Math.min(cue.end, section.end) - section.start,
      text: cue.text,
    }));
}

// Renders one section's plain solid-color background, a slow Ken Burns
// zoom (zoom-in on even sections / zoom-out on odd sections, for gentle
// visual variety), a short fade-to-black at each end, AND this section's
// own slice of the on-screen story/caption text — all burned in together
// in ONE ffmpeg pass. Every section is encoded with identical codec/
// resolution/fps settings so they can be concatenated afterward with
// `-c copy` (no quality loss, no further re-encoding).
// sectionCues: this section's cues, already localized by cuesForSection.
// effectiveDuration: this section's own rendered length — equal to
// section.end - section.start for every section except the last, which
// the caller extends to cover any real audio duration remaining after the
// last cue (see assembleSimpleStoryVideo for why this replaces a separate
// global padding pass).
// editSettings: an ALREADY-NORMALIZED videoEditSettings shape (see
// normalizeVideoEditSettings) — backgroundColor overrides the default
// rotating per-section palette with ONE fixed color for every section when
// set; everything else is passed straight through to buildAssScript.
async function renderSection(section, sectionIndex, workDir, sectionCues, effectiveDuration, editSettings = {}) {
  const duration = Math.max(0.5, effectiveDuration);
  const outPath = path.join(workDir, `section-${sectionIndex}.mp4`);
  const color = editSettings.backgroundColor || backgroundColorForSection(sectionIndex);
  const zoomingIn = sectionIndex % 2 === 0;
  const zoomExpr = zoomingIn ? 'min(zoom+0.0006,1.15)' : 'if(eq(on,0),1.15,max(zoom-0.0006,1.0))';

  const fadeDuration = Math.min(SECTION_FADE_SECONDS, duration / 2);
  const assPath = path.join(workDir, `section-${sectionIndex}.ass`);
  fs.writeFileSync(assPath, buildAssScript(sectionCues, duration, editSettings), 'utf8');

  const vf =
    `zoompan=z='${zoomExpr}':d=1:s=${SIMPLE_STORY_WIDTH}x${SIMPLE_STORY_HEIGHT}:fps=${SIMPLE_STORY_FPS},` +
    `fade=t=in:st=0:d=${fadeDuration.toFixed(3)},` +
    `fade=t=out:st=${Math.max(0, duration - fadeDuration).toFixed(3)}:d=${fadeDuration.toFixed(3)},` +
    `ass='${escapeFilterValue(assPath)}':fontsdir='${escapeFilterValue(FONTS_DIR)}'`;

  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x${color}:s=${SIMPLE_STORY_WIDTH}x${SIMPLE_STORY_HEIGHT}:r=${SIMPLE_STORY_FPS}:d=${duration.toFixed(3)}`,
    '-vf',
    vf,
    '-t',
    duration.toFixed(3),
    '-r',
    String(SIMPLE_STORY_FPS),
    '-c:v',
    'libx264',
    '-preset',
    SECTION_ENCODE_PRESET,
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);

  return outPath;
}

// The default, empty progress record for a job that has never started (or
// whose previous progress was just discarded as stale — see
// continueSimpleStoryVideoAssembly). Matches job-store.js's own
// simpleStoryRender default exactly.
function freshRenderProgress(voiceoverUrl, subtitlesContent, editSettingsSnapshot) {
  return {
    status: 'in_progress',
    totalSections: null,
    sections: [],
    audioUrlSnapshot: voiceoverUrl,
    subtitlesContentSnapshot: subtitlesContent,
    editSettingsSnapshot: editSettingsSnapshot || null,
    error: null,
  };
}

// voiceover: job.voiceover — REQUIRED here (unlike video-assembly.js's
// Runway pipeline, where narration is optional). Without real, timed
// narration there is nothing for the on-screen text to synchronize
// against, so the caller (server.js) must only ever call this once
// voiceover.status === 'completed'.
// subtitlesContent: job.subtitles.content — REQUIRED for the same reason;
// this is real, transcribed-from-this-audio text, never guessed from the
// script. The caller must only call this once subtitles.status ===
// 'completed'.
// existingRender: job.simpleStoryRender — this job's own persisted
// progress from any PREVIOUS call (or job-store.js's default
// { status: 'not_started', sections: [], ... } shape for a job that has
// never rendered before). Reused across separate invocations so an
// already-completed section is never re-rendered — see this module's own
// top comment and job-store.js's simpleStoryRender field comment for why:
// real production evidence showed a long story's full render (16+ real
// sections, each a real local ffmpeg encode) can take longer than a single
// serverless function invocation safely allows.
// jobId: needed to durably store each section's own rendered clip (see
// video-storage.js's storeSimpleStorySectionClip) as it completes, so that
// work survives between invocations even though each invocation's own
// /tmp does not.
// sectionTargetSeconds: optional override of DEFAULT_SECTION_TARGET_SECONDS
// — exposed so this module's own tests can force multiple short sections
// out of a short fixture, exercising the real section/transition logic
// without needing a multi-minute test fixture.
// timeBudgetMs: optional override of RENDER_TIME_BUDGET_MS — exposed so
// this module's own tests can force an early "still in progress" return
// without needing a slow, multi-minute fixture.
//
// Returns one of:
//   { status: 'completed', buffer, render } — the whole video is done.
//     buffer is the raw assembled MP4 bytes (see video-assembly.js's own
//     comment for why this deliberately returns a buffer, not a stored
//     url); render is the final, completed progress record to persist.
//   { status: 'in_progress', render } — real progress may have been made,
//     but sections remain; the caller persists `render` onto
//     job.simpleStoryRender and must call this again later (see
//     server.js's assembleAndStoreFinalVideo) to continue. Never blocks
//     past timeBudgetMs trying to finish everything in one call.
//   { status: 'failed', error, render } — a real failure. render still
//     reflects whatever sections completed before the failure, so a retry
//     never re-renders them.
// Never fabricates a buffer or a completed section.
async function continueSimpleStoryVideoAssembly({
  voiceover,
  subtitlesContent,
  existingRender,
  jobId,
  sectionTargetSeconds,
  timeBudgetMs,
  editSettings: rawEditSettings,
}) {
  if (!voiceover || voiceover.status !== 'completed' || !voiceover.url) {
    return { status: 'failed', error: 'A completed voice-over is required for Simple Story Video mode.', render: existingRender || null };
  }
  if (!subtitlesContent || !subtitlesContent.trim()) {
    return {
      status: 'failed',
      error: 'Real subtitles (generated from the voice-over) are required for Simple Story Video mode.',
      render: existingRender || null,
    };
  }

  const cues = parseSrt(subtitlesContent);
  if (cues.length === 0) {
    return { status: 'failed', error: 'Subtitles contained no usable cues to build the video from.', render: existingRender || null };
  }

  const editSettings = normalizeVideoEditSettings(rawEditSettings);
  const editSettingsSnapshot = JSON.stringify(editSettings);

  // A fresh voice-over, a real subtitles change, OR a changed
  // videoEditSettings invalidates every previously-rendered section — a
  // different background color, text style, or voice speed/volume changes
  // every section's own rendered pixels/audio just as much as a real
  // narration change does. Starting over here (rather than trying to
  // patch/diff the old progress) is simple and safe: sections are cheap to
  // re-render (a few seconds each with the ultrafast preset), so there is
  // no real cost to discarding stale progress outright.
  const isStale =
    !existingRender ||
    existingRender.audioUrlSnapshot !== voiceover.url ||
    existingRender.subtitlesContentSnapshot !== subtitlesContent ||
    (existingRender.editSettingsSnapshot || null) !== editSettingsSnapshot;

  const render = isStale
    ? freshRenderProgress(voiceover.url, subtitlesContent, editSettingsSnapshot)
    : { ...existingRender, sections: existingRender.sections.map((section) => ({ ...section })), status: 'in_progress', error: null };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-story-video-'));

  // Diagnostic timing log, one line per real phase — a hard platform
  // timeout kills the process before the catch block below ever runs, so
  // this module's own error handling has never been visible for a timeout,
  // only for a real thrown error. These lines are the only way to see,
  // after the fact in Vercel's logs, which phase was actually still
  // running when a timeout hits, instead of guessing. Never logs anything
  // from voiceover.url/subtitlesContent themselves (no narration text or
  // storage URLs), only counts and elapsed seconds.
  const assemblyStart = Date.now();
  const elapsedSeconds = () => ((Date.now() - assemblyStart) / 1000).toFixed(1);
  const log = (message) => console.log(`Simple Story Video assembly: ${message} (${elapsedSeconds()}s elapsed)`);

  try {
    log(`starting, ${cues.length} subtitle cue(s), resuming existing progress: ${!isStale}`);

    const audioPath = path.join(workDir, 'voiceover-audio');
    await fetchAudioToFile(voiceover.url, audioPath);
    // Applies voiceSpeed/voiceVolumeDb (if set) via local ffmpeg filters —
    // never a new text-to-speech call. Returns audioPath unchanged when
    // both are at their defaults, so a job with no voice edits pays no
    // extra ffmpeg cost here.
    const effectiveAudioPath = await prepareEffectiveAudio(audioPath, editSettings, workDir);
    const audioDuration = await getMediaDuration(effectiveAudioPath);
    log(`voice-over audio ready, real duration ${audioDuration.toFixed(1)}s`);

    // Rescales/shifts cue timestamps to match the EFFECTIVE (possibly sped-
    // up/slowed) audio timeline above — see applyCueTimingAdjustments — so
    // every downstream computation (section boundaries, per-section text
    // burn-in) already reflects any voice-speed/timing-offset edit, not
    // just the final mux.
    const adjustedCues = applyCueTimingAdjustments(cues, editSettings);
    if (adjustedCues.length === 0) {
      throw new Error('Subtitle timing adjustments left no usable cues — check subtitleTimingOffsetMs.');
    }

    const targetSectionSeconds = sectionTargetSeconds > 0 ? sectionTargetSeconds : DEFAULT_SECTION_TARGET_SECONDS;
    const sections = groupCuesIntoSections(adjustedCues, targetSectionSeconds, audioDuration);
    render.totalSections = sections.length;
    // Reconciles the persisted per-section progress array to this exact
    // section count/order — a no-op except on the very first call for this
    // job (or right after the staleness reset above), since the inputs
    // that determine section count/boundaries are the same voiceover/
    // subtitles just validated above and never change mid-stream.
    render.sections = sections.map((_, i) =>
      render.sections[i] && render.sections[i].status === 'completed' ? render.sections[i] : { status: 'pending', url: null }
    );

    const alreadyDoneCount = render.sections.filter((section) => section.status === 'completed').length;
    log(`grouped into ${sections.length} section(s), ${alreadyDoneCount} already completed from a previous call`);

    const pendingIndexes = sections.map((_, i) => i).filter((i) => render.sections[i].status !== 'completed');

    if (pendingIndexes.length > 0) {
      const deadlineAt = Date.now() + (timeBudgetMs > 0 ? timeBudgetMs : RENDER_TIME_BUDGET_MS);
      let renderedThisCall = 0;

      await mapWithConcurrencyUntilDeadline(pendingIndexes, SECTION_RENDER_CONCURRENCY, deadlineAt, async (sectionIndex) => {
        const section = sections[sectionIndex];
        // The visual timeline is built entirely from real section
        // boundaries (themselves derived from real cue timestamps), which
        // can end slightly before the real, measured audio duration (e.g.
        // a trailing pause after the last line) — never truncate real
        // narration. Extending the LAST section's own rendered duration to
        // cover the real audio duration (instead of a separate padding
        // pass over the whole video afterward, as this module used to do)
        // means every section already has real text burned in and the
        // concatenation step below never needs to re-encode anything,
        // regardless of the video's total length.
        const isLastSection = sectionIndex === sections.length - 1;
        const effectiveDuration = isLastSection
          ? Math.max(section.end, audioDuration) - section.start
          : section.end - section.start;
        const outPath = await renderSection(
          section,
          sectionIndex,
          workDir,
          cuesForSection(adjustedCues, section),
          effectiveDuration,
          editSettings
        );
        const buffer = fs.readFileSync(outPath);
        const url = await videoStorage.storeSimpleStorySectionClip(buffer, jobId, sectionIndex);
        render.sections[sectionIndex] = { status: 'completed', url };
        renderedThisCall++;
        log(`rendered section ${sectionIndex + 1}/${sections.length} (${renderedThisCall} section(s) this call)`);
      });
    }

    const stillPending = render.sections.some((section) => section.status !== 'completed');
    if (stillPending) {
      log('time budget reached with sections still pending — stopping for this call, will resume on the next one');
      return { status: 'in_progress', render };
    }
    log(`all ${sections.length} section(s) completed`);

    // Every section is done and durably stored — download each one's real
    // bytes back (some may have been rendered in an EARLIER call, whose own
    // /tmp is long gone by now) into this call's own workDir, then
    // concatenate exactly as before.
    const sectionPaths = [];
    for (let i = 0; i < render.sections.length; i++) {
      const sectionPath = path.join(workDir, `section-${i}.mp4`);
      await fetchAudioToFile(render.sections[i].url, sectionPath);
      sectionPaths.push(sectionPath);
    }
    log('all section clips fetched for concatenation');

    const listPath = path.join(workDir, 'sections.txt');
    fs.writeFileSync(listPath, sectionPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

    const concatenatedPath = path.join(workDir, 'concatenated.mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatenatedPath]);
    log('sections concatenated');

    // Every section already has its own text burned in and already covers
    // the real audio duration (see above), so all that's left is muxing in
    // the real narration audio — a plain stream copy of the already-final
    // video (-c:v copy), never a re-encode.
    const finalPath = path.join(workDir, 'final.mp4');

    await runFfmpeg([
      '-y',
      '-i',
      concatenatedPath,
      '-i',
      effectiveAudioPath,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      finalPath,
    ]);
    log('final audio mux complete');

    const buffer = fs.readFileSync(finalPath);
    log(`done, output is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB`);
    if (buffer.length === 0) {
      throw new Error('ffmpeg produced an empty output file.');
    }

    render.status = 'completed';
    return { status: 'completed', buffer, render };
  } catch (error) {
    const message = (error && error.message) || 'Unknown error assembling the Simple Story Video.';
    console.error('Simple Story Video assembly error:', JSON.stringify({ message }, null, 2));
    render.status = 'failed';
    render.error = message;
    return { status: 'failed', error: message, render };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Mirrors video-assembly.js's fetchToFile — used both for downloading the
// job's own voice-over audio and for re-fetching an already-rendered
// section's stored clip bytes back for concatenation (see
// continueSimpleStoryVideoAssembly), since both are just "real media bytes
// referenced by one of the shapes video-storage.js can produce." Every
// shape voiceover-generation.js's/this module's own storage can produce: a
// real http(s) URL (Vercel Blob in production), a /generated/... local
// reference (the no-Blob-token dev/test fallback, resolved straight from
// disk via GENERATED_DIR rather than fetched over HTTP, since this server
// has no fixed, known base URL to fetch its own static route from), a
// base64 data: URI (kept for backward compatibility with any job created
// before voice-over audio was moved out of the job record), or a plain
// local file path (this module's own tests).
async function fetchAudioToFile(url, destPath) {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    const base64 = commaIndex === -1 ? '' : url.slice(commaIndex + 1);
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) {
      throw new Error('Voice-over data: URI did not decode to any audio bytes.');
    }
    fs.writeFileSync(destPath, buffer);
    return;
  }

  if (url.startsWith('/generated/')) {
    const filePath = path.join(videoStorage.GENERATED_DIR, url.slice('/generated/'.length));
    fs.copyFileSync(filePath, destPath);
    return;
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download voice-over audio (HTTP ${response.status}) from ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error(`Downloaded voice-over audio from ${url} was empty.`);
    }
    fs.writeFileSync(destPath, buffer);
    return;
  }

  fs.copyFileSync(url, destPath);
}

module.exports = {
  continueSimpleStoryVideoAssembly,
  parseSrt,
  groupCuesIntoSections,
  wrapText,
  fitCueText,
  buildAssScript,
  cuesForSection,
  secondsToAssTimestamp,
  mapWithConcurrencyUntilDeadline,
  SECTION_RENDER_CONCURRENCY,
  SECTION_ENCODE_PRESET,
  RENDER_TIME_BUDGET_MS,
  SIMPLE_STORY_WIDTH,
  SIMPLE_STORY_HEIGHT,
  SIMPLE_STORY_FPS,
  DEFAULT_SECTION_TARGET_SECONDS,
  FONT_BOLD_PATH,
  FONT_REGULAR_PATH,
  FONTS_DIR,
  ffmpegPath,
  // Selective video editing (videoEditSettings) — exported for server.js's
  // updateVideoEditSettings tool (validation/normalization) and this
  // module's own tests.
  normalizeVideoEditSettings,
  applyCueTimingAdjustments,
  prepareEffectiveAudio,
  assColorFromHex,
  VOICE_SPEED_MIN,
  VOICE_SPEED_MAX,
  VOICE_VOLUME_DB_MIN,
  VOICE_VOLUME_DB_MAX,
  SUBTITLE_FONT_SCALE_MIN,
  SUBTITLE_FONT_SCALE_MAX,
  SUBTITLE_TIMING_OFFSET_MS_MIN,
  SUBTITLE_TIMING_OFFSET_MS_MAX,
  VALID_STORY_POSITIONS,
  VALID_FONT_WEIGHTS,
  HEX_COLOR_RE,
};
