// "Upload & Compile" per-clip AI voice-over (see job-store.js's
// VIDEO_MODES 'uploaded-clips' and its uploadedClips/clipVoiceoverVoice/
// clipVoiceoverBatch fields): the user uploads real scene clips they
// generated elsewhere (e.g. an external AI video tool) with no narration of
// their own, and this module generates a short, natural voice-over for
// whichever clips they explicitly select — never every uploaded clip
// automatically, so real paid-API spend is limited to exactly what was
// asked for (see server.js's POST /:id/select-clip-voiceovers and
// POST /:id/generate-clip-voiceovers).
//
// Two real paid calls per clip:
// 1. One short Claude vision call (this app's existing Anthropic key, the
//    same one already central to the whole app — not a new provider) looks
//    at ONE representative frame from the clip and writes a short, natural
//    narration line describing what's actually visible. It never fabricates
//    detail beyond the frame, and never mentions that it's looking at a
//    still image — the result must read as spoken narration for the moving
//    scene. Deliberately independent of the main Anthropic tool-use loop in
//    server.js, exactly like backend/reference-video.js's own standalone
//    call, using the same cheap claude-sonnet-5 model (no tool use, no job
//    state) rather than the main agent's model.
// 2. The existing OpenAI TTS pipeline (backend/voiceover-generation.js,
//    completely unchanged) synthesizes that narration line in the ONE AI
//    voice chosen for the whole batch.
//
// The resulting narration audio REPLACES the clip's own audio track
// entirely in the stored "processed" copy — never mixed/ducked under
// whatever audio the clip already had. A clip that already has real
// dialogue/sound is left alone unless the user explicitly selects it anyway
// (server.js warns about this before generating); once they do, layering a
// second spoken track underneath would only be confusing, so this always
// fully replaces rather than mixing two voices together. The clip's
// ORIGINAL uploaded bytes (job.uploadedClips[i].url) are never touched —
// only a separate processedUrl is produced — so the source upload stays
// available even after a voice-over is generated (or regenerated).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const videoAssembly = require('./video-assembly');
const videoStorage = require('./video-storage');
const voiceoverGeneration = require('./voiceover-generation');

const NARRATION_MODEL = 'claude-sonnet-5';

let cachedClient = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

// This module's own small ffmpeg wrapper, the same pattern already used
// independently in video-assembly.js and simple-story-video.js (each file
// keeps its own — never shared across files in this codebase).
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(videoAssembly.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || '').toString().trim().slice(-2000);
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

// Real, measured facts about an uploaded clip — its duration and whether it
// already has an audio stream — read via the exact same ffmpeg-decode-log
// checks video-assembly.js's own getMediaDuration/probeStreamTypes use, so
// this never re-implements (and risks disagreeing with) that logic. Called
// once, right after upload (see server.js's POST /:id/upload-clip), to
// populate uploadedClips[i].durationSeconds/hasAudio honestly rather than
// guessing from the file extension.
async function probeUploadedClip(url) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-probe-'));
  const filePath = path.join(workDir, 'input');
  try {
    await videoAssembly.fetchToFile(url, filePath);
    const durationSeconds = await videoAssembly.getMediaDuration(filePath);
    const { hasAudioStream } = await videoAssembly.probeStreamTypes(filePath);
    return { durationSeconds, hasAudio: hasAudioStream };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Writes ONE short, natural narration line from a single representative
// frame (the clip's own midpoint, extracted locally — never a paid API
// call by itself). Never fabricates specific claims the frame doesn't
// actually support, and never describes it as a still image/frame.
async function describeFrameForNarration(frameBuffer, { topic } = {}) {
  const topicLine = topic && topic.trim() ? `This clip is part of a video about: "${topic.trim()}".\n\n` : '';
  const prompt =
    topicLine +
    'This image is ONE representative frame from a short, silent AI-generated video clip (a few seconds ' +
    'long). Write ONE short, natural narration line (at most two short sentences) that a human video ' +
    'editor would add as voice-over for this exact moment, describing only what is actually visible — ' +
    'never inventing plot, dialogue, or detail beyond what the frame shows. Write it as spoken narration ' +
    'for the moving scene, never mentioning that this is an image or a still frame. Keep it concise enough ' +
    'to comfortably fit the clip\'s short length. Reply with ONLY the narration line itself — no quotes, ' +
    'labels, or extra commentary.';

  const client = getClient();
  const response = await client.messages.create({
    model: NARRATION_MODEL,
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: frameBuffer.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const textBlock = Array.isArray(response.content) ? response.content.find((block) => block.type === 'text') : null;
  const narrationText = textBlock && textBlock.text ? textBlock.text.trim() : '';
  if (!narrationText) {
    throw new Error('The narration call did not return any text.');
  }
  return narrationText;
}

// Generates and muxes in one clip's AI voice-over. Returns
// { status: 'completed', voiceoverUrl, processedUrl, narrationText, error: null }
// or { status: 'failed', voiceoverUrl: null, processedUrl: null, narrationText, error }.
// narrationText is included even on a failure that happens AFTER it was
// written (e.g. a TTS or ffmpeg error), so the caller can still show what
// would have been said. Never throws — every failure is reported this way,
// the same honest-failure discipline as voiceover-generation.js's own
// generateVoiceover.
async function generateClipVoiceover({ clipUrl, voiceStyle, jobId, clipId, topic }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-voiceover-'));
  const inputPath = path.join(workDir, 'input.mp4');
  let narrationText = null;

  try {
    await videoAssembly.fetchToFile(clipUrl, inputPath);
    const durationSeconds = await videoAssembly.getMediaDuration(inputPath);

    const atSeconds = Math.max(0, Math.min(durationSeconds / 2, Math.max(0, durationSeconds - 0.1)));
    const framePath = path.join(workDir, 'frame.png');
    await runFfmpeg(['-y', '-ss', atSeconds.toFixed(3), '-i', inputPath, '-frames:v', '1', '-q:v', '2', framePath]);
    const frameBuffer = fs.readFileSync(framePath);
    if (frameBuffer.length === 0) {
      throw new Error('Could not extract a frame from this clip.');
    }

    narrationText = await describeFrameForNarration(frameBuffer, { topic });

    const voiceoverResult = await voiceoverGeneration.generateVoiceover({
      script: narrationText,
      voiceStyle,
      jobId: `${jobId}-clip-${clipId}`,
    });
    if (voiceoverResult.status !== 'completed' || !voiceoverResult.url) {
      return {
        status: 'failed',
        voiceoverUrl: null,
        processedUrl: null,
        narrationText,
        error: voiceoverResult.error || 'Voice-over synthesis did not return audio.',
      };
    }

    const narrationPath = path.join(workDir, 'narration.mp3');
    await videoAssembly.fetchToFile(voiceoverResult.url, narrationPath);
    const narrationDurationSeconds = await videoAssembly.getMediaDuration(narrationPath);

    const outputPath = path.join(workDir, 'output.mp4');
    if (narrationDurationSeconds > durationSeconds) {
      // The narration runs longer than the clip's own video — extend the
      // video's last frame to cover it rather than cutting the narration
      // off mid-sentence.
      const extendSeconds = narrationDurationSeconds - durationSeconds;
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-i', narrationPath,
        '-filter_complex', `[0:v]tpad=stop_mode=clone:stop_duration=${extendSeconds.toFixed(3)}[v]`,
        '-map', '[v]',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-shortest',
        outputPath,
      ]);
    } else {
      // The narration fits within the clip's own length — pad it with
      // silence to that real duration so the clip's own full visual length
      // is preserved unchanged.
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-i', narrationPath,
        '-filter_complex', `[1:a]apad=whole_dur=${durationSeconds.toFixed(3)}[a]`,
        '-map', '0:v',
        '-map', '[a]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        outputPath,
      ]);
    }

    const outputBuffer = fs.readFileSync(outputPath);
    if (outputBuffer.length === 0) {
      throw new Error('ffmpeg produced an empty processed clip.');
    }

    const processedUrl = await videoStorage.storeProcessedClipFile(outputBuffer, jobId, clipId);

    return { status: 'completed', voiceoverUrl: voiceoverResult.url, processedUrl, narrationText, error: null };
  } catch (error) {
    console.error(
      'Clip voice-over generation error:',
      JSON.stringify({ jobId, clipId, message: (error && error.message) || String(error) }, null, 2)
    );
    return {
      status: 'failed',
      voiceoverUrl: null,
      processedUrl: null,
      narrationText,
      error: (error && error.message) || 'Unknown error generating this clip\'s voice-over.',
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { probeUploadedClip, describeFrameForNarration, generateClipVoiceover, NARRATION_MODEL };
