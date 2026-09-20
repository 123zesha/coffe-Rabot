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

// A short rotation of plain, high-contrast-with-white-text colors — "simple
// clean backgrounds" is implemented literally: a solid color, never a
// generated/fetched image, so this mode never depends on any image
// provider either. Hex values (no '#') for ffmpeg's color= source.
const SECTION_BACKGROUND_COLORS = ['1e293b', '0f4c4c', '2d3142', '14532d', '3f3d56', '4a2545', '1f2937', '3d2645'];

function backgroundColorForSection(sectionIndex) {
  return SECTION_BACKGROUND_COLORS[sectionIndex % SECTION_BACKGROUND_COLORS.length];
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

// Runs `mapper` over `items` with at most `limit` calls in flight at once,
// resolving to results in the SAME ORDER as `items` regardless of which
// call finishes first — required here because sectionPaths must stay in
// story order for the concat step below. A rejection from any call rejects
// the whole call, same as Promise.all.
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
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
function buildAssScript(cues, audioDuration) {
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
    // Story: large, centered (Alignment 5 = middle-center), an opaque box
    // background (BorderStyle 3) for readability over any background color.
    `Style: Story,${FONT_FAMILY},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,3,0,4,5,120,120,0,1\n` +
    // Caption: small, bottom-center (Alignment 2), plain outline (no box)
    // — the familiar closed-caption look, mirroring what burnInSubtitles
    // already produces elsewhere in this app.
    `Style: Caption,${FONT_FAMILY},30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,48,1\n\n` +
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
async function renderSection(section, sectionIndex, workDir, sectionCues, effectiveDuration) {
  const duration = Math.max(0.5, effectiveDuration);
  const outPath = path.join(workDir, `section-${sectionIndex}.mp4`);
  const color = backgroundColorForSection(sectionIndex);
  const zoomingIn = sectionIndex % 2 === 0;
  const zoomExpr = zoomingIn ? 'min(zoom+0.0006,1.15)' : 'if(eq(on,0),1.15,max(zoom-0.0006,1.0))';

  const fadeDuration = Math.min(SECTION_FADE_SECONDS, duration / 2);
  const assPath = path.join(workDir, `section-${sectionIndex}.ass`);
  fs.writeFileSync(assPath, buildAssScript(sectionCues, duration), 'utf8');

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
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);

  return outPath;
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
// sectionTargetSeconds: optional override of DEFAULT_SECTION_TARGET_SECONDS
// — exposed so this module's own tests can force multiple short sections
// out of a short fixture, exercising the real section/transition logic
// without needing a multi-minute test fixture.
//
// Returns { buffer, status: 'completed', error: null } on success (the raw
// assembled MP4 bytes — see video-assembly.js's own comment for why this
// deliberately returns a buffer, not a stored url) or
// { buffer: null, status: 'failed', error } on any real failure. Never
// fabricates a buffer.
async function assembleSimpleStoryVideo({ voiceover, subtitlesContent, sectionTargetSeconds }) {
  if (!voiceover || voiceover.status !== 'completed' || !voiceover.url) {
    return { buffer: null, status: 'failed', error: 'A completed voice-over is required for Simple Story Video mode.' };
  }
  if (!subtitlesContent || !subtitlesContent.trim()) {
    return {
      buffer: null,
      status: 'failed',
      error: 'Real subtitles (generated from the voice-over) are required for Simple Story Video mode.',
    };
  }

  const cues = parseSrt(subtitlesContent);
  if (cues.length === 0) {
    return { buffer: null, status: 'failed', error: 'Subtitles contained no usable cues to build the video from.' };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-story-video-'));

  try {
    const audioPath = path.join(workDir, 'voiceover-audio');
    await fetchAudioToFile(voiceover.url, audioPath);
    const audioDuration = await getMediaDuration(audioPath);

    const targetSectionSeconds = sectionTargetSeconds > 0 ? sectionTargetSeconds : DEFAULT_SECTION_TARGET_SECONDS;
    const sections = groupCuesIntoSections(cues, targetSectionSeconds, audioDuration);

    const sectionPaths = await mapWithConcurrency(sections, SECTION_RENDER_CONCURRENCY, (section, i) => {
      // The visual timeline is built entirely from real section boundaries
      // (themselves derived from real cue timestamps), which can end
      // slightly before the real, measured audio duration (e.g. a trailing
      // pause after the last line) — never truncate real narration.
      // Extending the LAST section's own rendered duration to cover the
      // real audio duration (instead of a separate padding pass over the
      // whole video afterward, as this module used to do) means every
      // section already has real text burned in and the concatenation step
      // below never needs to re-encode anything, regardless of the video's
      // total length.
      const isLastSection = i === sections.length - 1;
      const effectiveDuration = isLastSection
        ? Math.max(section.end, audioDuration) - section.start
        : section.end - section.start;
      return renderSection(section, i, workDir, cuesForSection(cues, section), effectiveDuration);
    });

    const listPath = path.join(workDir, 'sections.txt');
    fs.writeFileSync(listPath, sectionPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

    const concatenatedPath = path.join(workDir, 'concatenated.mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatenatedPath]);

    // Every section already has its own text burned in and already covers
    // the real audio duration (see above), so all that's left is muxing in
    // the real narration audio — a plain stream copy of the already-final
    // video (-c:v copy), never a re-encode. Previously this step also
    // burned in subtitles and padded for trailing silence in one combined
    // full-length re-encode pass; measured on a real 18-minute fixture that
    // pass alone took ~123s, and a real production job's total render still
    // exceeded Vercel's 300s function timeout even after parallelizing
    // section rendering — moving both burn-in and padding into the
    // per-section step above removes this remaining full-length re-encode
    // entirely, regardless of video length.
    const finalPath = path.join(workDir, 'final.mp4');

    await runFfmpeg([
      '-y',
      '-i',
      concatenatedPath,
      '-i',
      audioPath,
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

    const buffer = fs.readFileSync(finalPath);
    if (buffer.length === 0) {
      throw new Error('ffmpeg produced an empty output file.');
    }

    return { buffer, status: 'completed', error: null };
  } catch (error) {
    const message = (error && error.message) || 'Unknown error assembling the Simple Story Video.';
    console.error('Simple Story Video assembly error:', JSON.stringify({ message }, null, 2));
    return { buffer: null, status: 'failed', error: message };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Mirrors video-assembly.js's fetchToFile for the voice-over's own url —
// every shape voiceover-generation.js's storage can produce (see
// video-storage.js): a real http(s) URL (Vercel Blob in production), a
// /generated/... local reference (the no-Blob-token dev/test fallback,
// resolved straight from disk via GENERATED_DIR rather than fetched over
// HTTP, since this server has no fixed, known base URL to fetch its own
// static route from), a base64 data: URI (kept for backward compatibility
// with any job created before voice-over audio was moved out of the job
// record), or a plain local file path (this module's own tests).
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
  assembleSimpleStoryVideo,
  parseSrt,
  groupCuesIntoSections,
  wrapText,
  fitCueText,
  buildAssScript,
  cuesForSection,
  secondsToAssTimestamp,
  mapWithConcurrency,
  SECTION_RENDER_CONCURRENCY,
  SIMPLE_STORY_WIDTH,
  SIMPLE_STORY_HEIGHT,
  SIMPLE_STORY_FPS,
  DEFAULT_SECTION_TARGET_SECONDS,
  FONT_BOLD_PATH,
  FONT_REGULAR_PATH,
  FONTS_DIR,
  ffmpegPath,
};
