const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jobStore = require('./job-store');
const imageGeneration = require('./image-generation');
const voiceoverGeneration = require('./voiceover-generation');
const videoGeneration = require('./video-generation');
const videoAssembly = require('./video-assembly');
const videoStorage = require('./video-storage');
const referenceVideo = require('./reference-video');
const youtubePackage = require('./youtube-package');
const subtitlesGeneration = require('./subtitles-generation');
const musicLibrary = require('./music-library');
const simpleStoryVideo = require('./simple-story-video');

const app = express();
const PORT = process.env.PORT || 3000;

// TEMPORARY safety cap for live Runway testing: when a /generate-video (or
// generateSceneVideo Agent tool) call does NOT specify a sceneIndex — i.e.
// it would submit every scene in the job at once — the job must have
// EXACTLY this many video prompts/scenes, so a real full-job test can never
// accidentally submit more than a couple of paid Runway requests in one
// call. It never truncates a larger job down to this count — it refuses
// outright, before any provider call is made. This cap does NOT apply when
// sceneIndex is given: selecting one explicit scene already bounds that
// call to exactly one paid request no matter how many scenes the job has,
// so a genuine single-scene job (or any job size) can generate one
// specific scene without needing a fake extra scene just to satisfy this
// cap. Remove this cap once live testing beyond a small, fixed scene count
// is intentionally needed for full-job runs.
const TEMP_GENERATE_VIDEO_SCENE_CAP = 2;

// imagePrompts[i] and videoPrompts[i] are meant to describe the SAME scene
// — generateVideoForScenes (backend/video-generation.js) already assumes
// this positional pairing when it matches a video prompt to its scene
// image. Nothing previously enforced that pairing before either paid call,
// so a job could reach ASSET GENERATION with imagePrompts set (and real,
// paid scene images already generated) while videoPrompts stayed empty —
// discovered only once video generation was attempted, after the image
// spend had already happened. Checking this BEFORE the first paid call
// (image generation) means a missing/mismatched videoPrompts is caught
// before any money is spent, not after — and the returned message is
// actionable enough (which tool, which field, what shape) that the Agent
// can call updateVideoJob and fix it itself, without asking the user to
// manually repair job data.
// Simple Story Video mode (job.videoMode === 'simple-story') never uses
// Runway or OpenAI image generation — see job-store.js's VIDEO_MODES
// comment: its final video is rendered directly from the script/voice-over/
// subtitles via local ffmpeg only (backend/simple-story-video.js). This is
// a hard, code-level guard shared by every entry point that could trigger
// either paid call (the generateSceneImages/generateSceneVideo Agent tools
// AND their equivalent REST routes) — never just prompt discipline — so a
// 'simple-story' job can never rack up Runway/OpenAI-image spend by
// accident.
function findPaidVisualGenerationBlocker(job, toolLabel) {
  if (job.videoMode === 'simple-story') {
    return (
      `This job is set to Simple Story Video mode, which never uses ${toolLabel} — it is assembled ` +
      'directly from the script, voice-over, and subtitles using local ffmpeg only. Generate the ' +
      'voice-over and subtitles instead, then call assembleFinalVideo.'
    );
  }
  return null;
}

function findScenePromptMismatch(job) {
  const imageCount = Array.isArray(job.imagePrompts) ? job.imagePrompts.length : 0;
  const videoCount = Array.isArray(job.videoPrompts) ? job.videoPrompts.length : 0;

  if (imageCount === 0) {
    return 'There are no imagePrompts yet. Use updateVideoJob to set imagePrompts first.';
  }

  if (videoCount === 0) {
    return (
      `There are ${imageCount} imagePrompts but 0 videoPrompts. Use updateVideoJob to set ` +
      'videoPrompts with one motion-description entry per imagePrompts entry, in the same scene ' +
      'order, before generating any scene images or video.'
    );
  }

  if (videoCount !== imageCount) {
    return (
      `imagePrompts has ${imageCount} entries but videoPrompts has ${videoCount}. Use ` +
      'updateVideoJob to make videoPrompts match imagePrompts one-to-one (same length, same scene ' +
      'order) before generating any scene images or video.'
    );
  }

  // Both feed a real paid API call downstream as raw text (the image
  // generation prompt, Runway's promptText) with no defensive coercion —
  // a non-string entry here isn't caught until the provider itself rejects
  // it (e.g. Runway's real, paid "promptText: Invalid input: expected
  // string, received object"). updateVideoJob's own schema now requires
  // string items, but this checks the job's actual current data too, so a
  // job left over from before that schema existed is still caught safely.
  const firstNonStringImagePrompt = job.imagePrompts.findIndex((prompt) => typeof prompt !== 'string');
  if (firstNonStringImagePrompt !== -1) {
    return (
      `imagePrompts[${firstNonStringImagePrompt}] is not a plain string. Use updateVideoJob to set ` +
      'every imagePrompts entry as a short text description, not an object.'
    );
  }

  const firstNonStringVideoPrompt = job.videoPrompts.findIndex((prompt) => typeof prompt !== 'string');
  if (firstNonStringVideoPrompt !== -1) {
    return (
      `videoPrompts[${firstNonStringVideoPrompt}] is not a plain string. Use updateVideoJob to set ` +
      'every videoPrompts entry as a short text description, not an object.'
    );
  }

  return null;
}

// job.videoGeneration.clips[i] must actually exist and be 'completed' — with
// a real url — for every scene before assembleFinalVideo (backend/
// video-assembly.js) is called; assembling from a clip that is missing,
// still processing, or failed would either crash ffmpeg or silently produce
// a final video with a scene missing. Checking this up front, by scene
// number, lets the error tell the Agent exactly which scene still needs
// generateSceneVideo, the same actionable style as findScenePromptMismatch.
function findFinalVideoBlocker(job) {
  // Simple Story Video mode has entirely different prerequisites — no
  // scenes/clips at all, just a real script, a completed voice-over, and
  // real subtitles (which drive the on-screen text's timing; see
  // backend/simple-story-video.js). Checked first so this never falls
  // through into the Runway-clip checks below, which would report
  // irrelevant "missing videoPrompts/clips" errors for a mode that never
  // has any.
  if (job.videoMode === 'simple-story') {
    if (!job.script || !job.script.trim()) {
      return 'There is no script yet, so there is nothing to narrate. Write the script first.';
    }
    if (!job.voiceover || job.voiceover.status !== 'completed' || !job.voiceover.url) {
      return 'A completed voice-over is required for Simple Story Video mode. Use generateVoiceover first.';
    }
    if (!job.subtitles || job.subtitles.status !== 'completed' || !job.subtitles.content) {
      return (
        'Real subtitles are required for Simple Story Video mode — they drive the synchronized ' +
        'on-screen story text, not just captions. Use generateSubtitles first.'
      );
    }
    return null;
  }

  const expectedCount = Array.isArray(job.videoPrompts) ? job.videoPrompts.length : 0;
  const clips = job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

  if (expectedCount === 0) {
    return 'There are no videoPrompts yet, so there are no scene video clips to assemble. Set up scene video generation first.';
  }

  if (clips.length === 0) {
    return (
      'No scene video clips have been generated yet. Use generateSceneVideo to generate every ' +
      "scene's video clip before assembling the final video."
    );
  }

  if (clips.length !== expectedCount) {
    return (
      `Only ${clips.length} of ${expectedCount} scene video clip(s) exist yet. Use generateSceneVideo ` +
      'to generate the remaining scene(s) before assembling the final video.'
    );
  }

  const incompleteIndex = clips.findIndex((clip) => !clip || clip.status !== 'completed');
  if (incompleteIndex !== -1) {
    const status = clips[incompleteIndex] ? clips[incompleteIndex].status : 'not_started';
    return (
      `Scene ${incompleteIndex + 1}'s video clip is not completed yet (status: ${status}). Use ` +
      'generateSceneVideo to finish every scene before assembling the final video.'
    );
  }

  // burnInSubtitles is an explicit request for captions to actually be
  // baked into the video — assembling without them in that case would
  // silently produce a final video that doesn't match what was asked for.
  // Never invents captions to satisfy this; the real .srt must already
  // exist (via generateSubtitles) first.
  if (job.burnInSubtitles && (!job.subtitles || job.subtitles.status !== 'completed' || !job.subtitles.content)) {
    return (
      'burnInSubtitles is enabled but no real subtitles have been generated yet. Use generateSubtitles ' +
      'first (it requires a completed voice-over), or turn burnInSubtitles off with updateVideoJob.'
    );
  }

  return null;
}

// Runs the real ffmpeg assembly step (backend/video-assembly.js) and, only
// on success, stores the resulting bytes outside the job record itself
// (backend/video-storage.js) — see that module's comment for why an
// assembled multi-scene video must never be embedded directly in
// job.finalVideo.url the way images/voiceover are. Shared by the
// assembleFinalVideo Agent tool and its REST route so the two never drift.
//
// Before assembling, every clip is passed through
// videoGeneration.ensureClipStored — a real production failure this caught
// live: findFinalVideoBlocker already guarantees every clip's STATUS reads
// 'completed', but a clip completed before permanent clip storage existed
// still pointed at the provider's own temporary output link, which Runway's
// own docs confirm expires within 24-48 hours. Assembly would then fail
// trying to download an already-dead link. ensureClipStored heals that for
// free (a re-fetch of the same completed task, never a new paid
// submission) — see its own comment in video-generation.js — and any
// healed/recovered clip is persisted back onto the job immediately, so this
// self-heals at most once per clip.
//
// desiredSubtitlesContent is the exact .srt text (or null) THIS assembly
// should end up reflecting, computed by the caller from the job's current
// burnInSubtitles setting and subtitles.content — see the skip-check
// below, which compares this against the existing finalVideo.subtitlesUsed
// so a stale caption-less (or stale-captioned) video is never silently
// served just because assembling again is normally skipped. Assembly calls
// no paid API, so redoing it whenever burnInSubtitles/subtitles has
// actually changed costs nothing.
//
// desiredMusicUsed is the exact music snapshot (see computeDesiredMusicUsed
// below) THIS assembly should end up reflecting — same role as
// desiredSubtitlesContent, compared against finalVideo.musicUsed.
// desiredResolutionUsed is job.resolutionTier itself (see
// isFinalVideoStillAccurate) — same role again, compared against
// finalVideo.resolutionUsed.
// desiredVideoModeUsed is job.videoMode itself (see computeDesiredVideoModeUsed
// below) — which of the two pipelines below actually runs.
//
// Returns { finalVideo, simpleStoryRender } — BOTH must be persisted by the
// caller (jobStore.updateJob(jobId, { finalVideo, simpleStoryRender })).
// simpleStoryRender only ever actually changes for the simple-story
// pipeline below; the cinematic pipeline passes job.simpleStoryRender
// through unchanged (a harmless no-op write), so both callers can always
// persist both fields the same way regardless of which pipeline ran.
async function assembleAndStoreFinalVideo(
  job,
  jobId,
  desiredSubtitlesContent,
  desiredMusicUsed,
  desiredResolutionUsed,
  desiredVideoModeUsed
) {
  // Simple Story Video mode: an entirely separate, local-ffmpeg-only
  // pipeline (backend/simple-story-video.js) — no scene clips, no Runway
  // healing, no music/resolution tier (that pipeline is always fixed
  // 1080p/16:9 with no music, per its own module comment). subtitlesUsed
  // still records the real subtitles content actually burned in — the same
  // "was this reassembled since a real change" bookkeeping role it has for
  // the Runway pipeline below.
  //
  // A real 15-20 minute story's full render (16+ real sections) can take
  // longer than one serverless function invocation safely allows — see
  // continueSimpleStoryVideoAssembly's own comment. So THIS call may only
  // make partial progress ('in_progress') rather than fully finishing;
  // finalVideo.status reads 'processing' in that case (never 'failed' —
  // nothing has gone wrong, more work is simply still needed), and the
  // caller (the assembleFinalVideo Agent tool / its REST route) is
  // expected to be called again later to continue — see the frontend's own
  // polling loop in refreshFinalVideoCard, which drives this to completion
  // via plain repeated HTTP calls, never by looping the conversational
  // agent purely to advance a mechanical render with nothing left to
  // reason about.
  if (desiredVideoModeUsed === 'simple-story') {
    const assembly = await simpleStoryVideo.continueSimpleStoryVideoAssembly({
      voiceover: job.voiceover,
      subtitlesContent: job.subtitles && job.subtitles.status === 'completed' ? job.subtitles.content : null,
      existingRender: job.simpleStoryRender,
      jobId,
      editSettings: job.videoEditSettings,
    });

    if (assembly.status === 'in_progress') {
      return {
        finalVideo: {
          url: null,
          status: 'processing',
          subtitlesUsed: null,
          musicUsed: null,
          resolutionUsed: null,
          videoModeUsed: null,
          editSettingsUsed: null,
          error: null,
        },
        simpleStoryRender: assembly.render,
      };
    }

    if (assembly.status !== 'completed') {
      return {
        finalVideo: {
          url: null,
          status: 'failed',
          subtitlesUsed: null,
          musicUsed: null,
          resolutionUsed: null,
          videoModeUsed: null,
          editSettingsUsed: null,
          error: assembly.error || 'Simple Story Video assembly failed.',
        },
        simpleStoryRender: assembly.render,
      };
    }

    try {
      const url = await videoStorage.storeFinalVideo(assembly.buffer, jobId);
      return {
        finalVideo: {
          url,
          status: 'completed',
          subtitlesUsed: job.subtitles.content,
          musicUsed: null,
          resolutionUsed: null,
          videoModeUsed: 'simple-story',
          editSettingsUsed: simpleStoryVideo.normalizeVideoEditSettings(job.videoEditSettings),
          error: null,
        },
        simpleStoryRender: assembly.render,
      };
    } catch (error) {
      console.error(
        'Simple Story Video storage error:',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return {
        finalVideo: {
          url: null,
          status: 'failed',
          subtitlesUsed: null,
          musicUsed: null,
          resolutionUsed: null,
          videoModeUsed: null,
          editSettingsUsed: null,
          error: `The final video was assembled but could not be stored: ${error.message}`,
        },
        simpleStoryRender: assembly.render,
      };
    }
  }

  const originalClips = job.videoGeneration.clips;
  const healedClips = [];
  for (let i = 0; i < originalClips.length; i++) {
    healedClips.push(await videoGeneration.ensureClipStored({ clip: originalClips[i], jobId, sceneIndex: i }));
  }

  if (healedClips.some((clip, i) => clip !== originalClips[i])) {
    await jobStore.updateJob(jobId, { videoGeneration: { ...job.videoGeneration, clips: healedClips } });
  }

  const brokenIndex = healedClips.findIndex((clip) => clip.status !== 'completed');
  if (brokenIndex !== -1) {
    return {
      finalVideo: {
        url: null,
        status: 'failed',
        subtitlesUsed: null,
        musicUsed: null,
        resolutionUsed: null,
        videoModeUsed: null,
        editSettingsUsed: null,
        error:
          `Scene ${brokenIndex + 1}'s video clip could not be verified or recovered before assembly ` +
          `(${healedClips[brokenIndex].error || 'unknown error'}) — regenerate it with generateSceneVideo.`,
      },
      simpleStoryRender: job.simpleStoryRender,
    };
  }

  // Resolving a job's music settings to a real local file can fail (an
  // unknown musicTrack, or a library file the user removed after selecting
  // it) — caught here so that reads as a clear assembly failure with an
  // actionable message, never an unhandled exception.
  let musicUrl;
  try {
    musicUrl = musicLibrary.resolveJobMusicUrl(job);
  } catch (error) {
    return {
      finalVideo: {
        url: null,
        status: 'failed',
        subtitlesUsed: null,
        musicUsed: null,
        resolutionUsed: null,
        videoModeUsed: null,
        editSettingsUsed: null,
        error: error.message,
      },
      simpleStoryRender: job.simpleStoryRender,
    };
  }

  const assembly = await videoAssembly.assembleFinalVideo({
    clips: healedClips,
    voiceover: job.voiceover,
    burnInSubtitlesContent: desiredSubtitlesContent,
    outputFormat: job.outputFormat,
    musicUrl,
    resolutionTier: job.resolutionTier,
  });

  if (assembly.status !== 'completed') {
    return {
      finalVideo: {
        url: null,
        status: 'failed',
        subtitlesUsed: null,
        musicUsed: null,
        resolutionUsed: null,
        videoModeUsed: null,
        editSettingsUsed: null,
        error: assembly.error || 'Final video assembly failed.',
      },
      simpleStoryRender: job.simpleStoryRender,
    };
  }

  try {
    const url = await videoStorage.storeFinalVideo(assembly.buffer, jobId);
    return {
      finalVideo: {
        url,
        status: 'completed',
        subtitlesUsed: desiredSubtitlesContent,
        musicUsed: desiredMusicUsed,
        resolutionUsed: desiredResolutionUsed,
        videoModeUsed: desiredVideoModeUsed,
        editSettingsUsed: null,
        error: null,
      },
      simpleStoryRender: job.simpleStoryRender,
    };
  } catch (error) {
    console.error(
      'Final video storage error:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    return {
      finalVideo: {
        url: null,
        status: 'failed',
        subtitlesUsed: null,
        musicUsed: null,
        resolutionUsed: null,
        videoModeUsed: null,
        editSettingsUsed: null,
        error: `The final video was assembled but could not be stored: ${error.message}`,
      },
      simpleStoryRender: job.simpleStoryRender,
    };
  }
}

// The exact music snapshot THIS job's settings would produce if assembled
// right now — null when music is off/unset (the default), matching
// job-store.js's musicEnabled/musicTrack/musicCustomUrl fields exactly.
// Stored on finalVideo.musicUsed once actually assembled, and recomputed
// here every time to detect a real settings change (mirrors
// desiredSubtitlesContent's role for burnInSubtitles/subtitles).
function computeDesiredMusicUsed(job) {
  if (!job.musicEnabled || (!job.musicTrack && !job.musicCustomUrl)) {
    return null;
  }
  return { enabled: true, track: job.musicTrack || null, customUrl: job.musicCustomUrl || null };
}

// The resolutionTier THIS job's settings would produce if assembled right
// now — job.resolutionTier itself (defaults to '720p'), a plain scalar so
// no computation is needed, but named to match computeDesiredMusicUsed's
// role for symmetry with finalVideo.resolutionUsed.
function computeDesiredResolutionUsed(job) {
  return job.resolutionTier || jobStore.DEFAULT_RESOLUTION_TIER;
}

// The videoMode THIS job's settings would produce if assembled right now —
// job.videoMode itself (defaults to 'cinematic'), same role as
// computeDesiredResolutionUsed for finalVideo.videoModeUsed.
function computeDesiredVideoModeUsed(job) {
  return job.videoMode || jobStore.DEFAULT_VIDEO_MODE;
}

// Whether an existing job.finalVideo is still accurate and can be served
// as-is (never re-run ffmpeg unnecessarily), vs. must be reassembled
// because burnInSubtitles, subtitles.content, the music settings, or the
// resolution tier have changed since it was built — see
// assembleAndStoreFinalVideo's own comment on subtitlesUsed/musicUsed/
// resolutionUsed. Shared by the assembleFinalVideo Agent tool and its REST
// route.
function isFinalVideoStillAccurate(job) {
  if (!job.finalVideo || job.finalVideo.status !== 'completed' || !job.finalVideo.url) {
    return false;
  }

  const desiredVideoModeUsed = computeDesiredVideoModeUsed(job);
  if ((job.finalVideo.videoModeUsed || jobStore.DEFAULT_VIDEO_MODE) !== desiredVideoModeUsed) {
    return false;
  }

  if (desiredVideoModeUsed === 'simple-story') {
    // Simple Story Video mode always uses subtitles as its on-screen text
    // source (not conditional on burnInSubtitles — see findFinalVideoBlocker)
    // and never applies music/resolutionTier (that pipeline is always fixed
    // 1080p/16:9 with no music — see simple-story-video.js). Checking those
    // here would force a pointless reassembly on every check, since this
    // pipeline never sets musicUsed/resolutionUsed to anything but null.
    const desiredSubtitlesContent =
      job.subtitles && job.subtitles.status === 'completed' ? job.subtitles.content : null;
    if ((job.finalVideo.subtitlesUsed || null) !== desiredSubtitlesContent) {
      return false;
    }
    // A real videoEditSettings change (background color, subtitle
    // appearance/timing, voice speed/volume — see updateVideoEditSettings)
    // must also force a real reassembly, exactly like a real subtitles
    // change does, even though nothing else here changed.
    const desiredEditSettings = simpleStoryVideo.normalizeVideoEditSettings(job.videoEditSettings);
    return JSON.stringify(job.finalVideo.editSettingsUsed || null) === JSON.stringify(desiredEditSettings);
  }

  const desiredSubtitlesContent =
    job.burnInSubtitles && job.subtitles && job.subtitles.status === 'completed' ? job.subtitles.content : null;
  if ((job.finalVideo.subtitlesUsed || null) !== desiredSubtitlesContent) {
    return false;
  }
  const desiredMusicUsed = computeDesiredMusicUsed(job);
  if (JSON.stringify(job.finalVideo.musicUsed || null) !== JSON.stringify(desiredMusicUsed)) {
    return false;
  }
  const desiredResolutionUsed = computeDesiredResolutionUsed(job);
  return (job.finalVideo.resolutionUsed || jobStore.DEFAULT_RESOLUTION_TIER) === desiredResolutionUsed;
}

// job.script must be a real, complete script and voiceStyle must not be
// 'none' before any real OpenAI TTS call — checked once here so the
// existing REST route (the Final Review "Generate Voice-over" button) and
// the generateVoiceover Agent tool can never diverge or duplicate this
// logic (mirrors findScenePromptMismatch/findFinalVideoBlocker's role for
// their own pipelines).
function findVoiceoverBlocker(job) {
  if (!job.script || !job.script.trim()) {
    return 'job has no script to generate a voice-over from';
  }

  if (job.script.trim().length < jobStore.MIN_SCRIPT_LENGTH) {
    return (
      `the script is too short to be an approved, complete script (needs at least ` +
      `${jobStore.MIN_SCRIPT_LENGTH} characters) — finish scripting before generating a voice-over`
    );
  }

  if (job.voiceStyle === 'none') {
    return 'this job is set to no voice-over (text only)';
  }

  return null;
}

// job.script must be a real, complete script before generating an optional
// YouTube publishing package from it — checked once here so the
// generateYoutubePackage Agent tool and its REST route
// (POST /api/jobs/:id/generate-youtube-package) can never diverge (mirrors
// findVoiceoverBlocker's role for its own pipeline). Deliberately does NOT
// check job.generateYoutubePackage here — that toggle is a prompt-level
// consent gate (see prompts/system-prompt.md), not a hard code refusal, so
// an explicit chat request ("create the title and thumbnail for this
// video") or a direct REST/button call still works even if the checkbox was
// never turned on; the Agent is instructed to record that consent via
// updateVideoJob when it happens.
function findYoutubePackageBlocker(job) {
  if (!job.script || !job.script.trim()) {
    return 'job has no finished script yet to base a YouTube package on';
  }

  if (job.script.trim().length < jobStore.MIN_SCRIPT_LENGTH) {
    return (
      `the script is too short to be an approved, complete script (needs at least ` +
      `${jobStore.MIN_SCRIPT_LENGTH} characters) — finish scripting before generating a YouTube package`
    );
  }

  return null;
}

// Runs the real text (Claude) + thumbnail image (OpenAI, best-effort)
// generation and persists the result. Shared by the generateYoutubePackage
// Agent tool and its REST route so the two never drift (mirrors
// assembleAndStoreFinalVideo's role for its own pipeline). Skips the real
// calls entirely — returning the existing job unchanged — when the job
// already has a completed package generated from this exact script and
// forceRegenerate wasn't requested, so asking again for an unchanged video
// never re-spends real API credits. A failed generation is never cached
// (generatedFromScript is left null on failure), so it always retries.
async function runGenerateYoutubePackage(job, jobId, { forceRegenerate } = {}) {
  const currentScript = job.script.trim();
  const existingPackage = job.youtubePackage;

  if (
    !forceRegenerate &&
    existingPackage &&
    existingPackage.status === 'completed' &&
    existingPackage.generatedFromScript === currentScript
  ) {
    return job;
  }

  const textResult = await youtubePackage.generateYoutubeTextPackage({
    topic: job.topic,
    duration: job.duration,
    language: job.language,
    storyStyle: job.storyStyle,
    script: job.script,
  });

  if (textResult.status !== 'completed') {
    const failedPackage = {
      status: 'failed',
      titles: [],
      description: null,
      tags: [],
      thumbnailConcept: null,
      thumbnailText: null,
      thumbnailUrl: null,
      error: textResult.error || 'YouTube package generation failed.',
      generatedFromScript: null,
    };
    return jobStore.updateJob(jobId, { youtubePackage: failedPackage });
  }

  // The thumbnail IMAGE is best-effort: OpenAI may not be configured, or the
  // real call may fail, but the rest of the package (titles/description/
  // tags/thumbnail concept) still came from a real, successful Claude call
  // and should still be reported as completed — never discarded just
  // because the optional image step didn't work.
  let thumbnailUrl = null;
  let thumbnailError = null;
  if (process.env.OPENAI_API_KEY) {
    const thumbnailResult = await imageGeneration.generateThumbnailImage({
      thumbnailConcept: textResult.thumbnailConcept,
      thumbnailText: textResult.thumbnailText,
      jobId,
    });
    thumbnailUrl = thumbnailResult.status === 'completed' ? thumbnailResult.url : null;
    thumbnailError = thumbnailResult.status === 'failed' ? thumbnailResult.error : null;
  } else {
    thumbnailError =
      'Thumbnail image generation is not configured on the server (OPENAI_API_KEY missing) — ' +
      'titles/description/tags/thumbnail concept were still generated.';
  }

  const youtubePackageField = {
    status: 'completed',
    titles: textResult.titles,
    description: textResult.description,
    tags: textResult.tags,
    thumbnailConcept: textResult.thumbnailConcept,
    thumbnailText: textResult.thumbnailText,
    thumbnailUrl,
    error: thumbnailError,
    generatedFromScript: currentScript,
  };

  return jobStore.updateJob(jobId, { youtubePackage: youtubePackageField });
}

// A real, completed voice-over is the ONLY honest source of subtitle
// timing (see backend/subtitles-generation.js's own comment) — checked
// once here so the generateSubtitles Agent tool and its REST route
// (POST /api/jobs/:id/generate-subtitles) can never diverge. Deliberately
// refuses rather than silently triggering voice-over generation itself:
// that is its own real, paid, consent-gated action (see
// findVoiceoverBlocker/generateVoiceover) that only happens when the user
// explicitly asks for it, never as a side effect of asking for subtitles.
function findSubtitlesBlocker(job) {
  if (job.voiceStyle === 'none') {
    return 'this job is set to no voice-over (text only) — there is no narration audio to caption';
  }

  if (!job.voiceover || job.voiceover.status !== 'completed' || !job.voiceover.url) {
    return (
      'there is no completed voice-over yet to transcribe. Subtitles are generated from the real, ' +
      'already-generated narration audio, never guessed from the script — call generateVoiceover first.'
    );
  }

  return null;
}

// Runs the real transcription call and persists the result. Shared by the
// generateSubtitles Agent tool and its REST route so the two never drift
// (mirrors runGenerateYoutubePackage's role for its own pipeline).
//
// Skip-guard note: this compares against the EXACT voiceover.url the
// subtitles were last transcribed from, not just "a voice-over exists" —
// the same real audio bytes always transcribe to the same correct
// captions, so skipping a re-transcription of byte-identical audio never
// trades away accuracy. Any actual change to the voice-over (a new
// generateVoiceover call always produces a new url — see its own
// finalVideo-reset comment) is a different, real url, so it always
// forces a fresh, real transcription rather than reusing stale captions.
// A failed transcription is never cached (generatedFromVoiceoverUrl is
// left null on failure), so it always retries.
async function runGenerateSubtitles(job, jobId, { forceRegenerate } = {}) {
  const currentVoiceoverUrl = job.voiceover.url;
  const existingSubtitles = job.subtitles;

  if (
    !forceRegenerate &&
    existingSubtitles &&
    existingSubtitles.status === 'completed' &&
    existingSubtitles.generatedFromVoiceoverUrl === currentVoiceoverUrl
  ) {
    return job;
  }

  const result = await subtitlesGeneration.generateSubtitles({ voiceoverUrl: currentVoiceoverUrl });

  const subtitlesField =
    result.status === 'completed'
      ? {
          status: 'completed',
          format: result.format,
          content: result.content,
          error: null,
          generatedFromVoiceoverUrl: currentVoiceoverUrl,
        }
      : {
          status: 'failed',
          format: 'srt',
          content: null,
          error: result.error || 'Subtitle generation failed.',
          generatedFromVoiceoverUrl: null,
        };

  return jobStore.updateJob(jobId, { subtitles: subtitlesField });
}

const client = new Anthropic();

// Parsed first (rather than kept as the raw file string) so the user-
// maintained local music library (backend/music-library.js — never
// downloaded or generated by this app) can be merged in as
// musicTrackOptions before this is embedded verbatim in the system prompt
// and returned by getVideoOptions below. Single source of truth: the
// actual selectable options in data/video-options.json plus the actual
// tracks currently listed in data/music/manifest.json, never a separately
// hardcoded list that could quietly drift out of sync.
const VIDEO_OPTIONS_DATA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'data', 'video-options.json'), 'utf8')
);
VIDEO_OPTIONS_DATA.musicTrackOptions = musicLibrary.getMusicTrackOptions();
const VIDEO_OPTIONS = JSON.stringify(VIDEO_OPTIONS_DATA, null, 2);
// 'none' ("No Voice-Over") is a real choice for voiceStyle itself (set via
// updateVideoJob), but not a valid input to the generateVoiceover tool —
// generating "no voice" makes no sense, so it's excluded from this list.
const VOICE_STYLE_OPTIONS = VIDEO_OPTIONS_DATA.voiceOverOptions
  .map((option) => option.value)
  .filter((value) => value !== 'none');
// Constrains updateVideoJob's musicTrack input the same way voiceStyle is
// constrained above — never a separately hardcoded list.
const MUSIC_TRACK_OPTIONS = VIDEO_OPTIONS_DATA.musicTrackOptions.map((option) => option.value);

const SYSTEM_PROMPT_BASE =
  fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8') +
  '\n\n## Available Video Production Options\n' +
  'These are the ONLY video production options you may offer, confirm, or use. ' +
  'Do not invent, assume, or suggest any language, duration, video style, story/video type, ' +
  'voice-over option, visual style, output option, or music track that is not listed below ' +
  '(musicTrackOptions may legitimately be empty — no bundled music ships with this app).\n\n' +
  VIDEO_OPTIONS;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble reaching the AI Agent right now. Please try again in a moment.";

const UPDATABLE_JOB_FIELDS = [
  'topic',
  'videoTitle',
  'duration',
  'language',
  'storyStyle',
  'script',
  'scenes',
  'characters',
  'imagePrompts',
  'videoPrompts',
  'voiceStyle',
  'referenceVideoUrl',
  'referenceVideoNotes',
  'musicEnabled',
  'musicTrack',
  'musicCustomUrl',
  'thumbnail',
  'description',
  'generateYoutubePackage',
  'burnInSubtitles',
  'outputFormat',
  'resolutionTier',
  'videoMode',
];

// job.images[].url and job.voiceover.url each hold a full base64-encoded
// media file (real generated images/audio are commonly hundreds of KB to a
// few MB). The agent never needs the actual bytes to write scripts, plan
// scenes, or decide when to advance stages — only whether generation
// succeeded. Embedding raw media in every tool_result and system prompt
// bloats the conversation history the frontend echoes back on every
// subsequent /api/agent request, which is what previously caused it to
// exceed the request body size limit once a job had generated images. The
// real media is untouched in Redis and stays fully available via
// /api/jobs/:id and the dashboard — this only shapes what the
// agent/conversation sees.
function summarizeJobForAgent(job) {
  if (!job) {
    return job;
  }

  const summarized = { ...job };

  if (Array.isArray(job.images)) {
    summarized.images = job.images.map(({ prompt, status, error }) => ({
      prompt,
      status,
      ...(error ? { error } : {}),
    }));
  }

  if (job.voiceover && typeof job.voiceover === 'object') {
    const { status, voice, voiceStyle, error } = job.voiceover;
    summarized.voiceover = {
      status,
      ...(voice ? { voice } : {}),
      ...(voiceStyle ? { voiceStyle } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (job.videoGeneration && typeof job.videoGeneration === 'object') {
    const { provider, status, error, clips } = job.videoGeneration;
    summarized.videoGeneration = {
      provider,
      status,
      ...(error ? { error } : {}),
      ...(Array.isArray(clips)
        ? { clips: clips.map((clip) => ({ status: clip.status, ...(clip.error ? { error: clip.error } : {}) })) }
        : {}),
    };
  }

  if (job.finalVideo && typeof job.finalVideo === 'object') {
    const { status, error, subtitlesUsed, musicUsed, resolutionUsed, videoModeUsed } = job.finalVideo;
    summarized.finalVideo = {
      status,
      ...(error ? { error } : {}),
      hasBurnedInSubtitles: Boolean(subtitlesUsed),
      hasMusic: Boolean(musicUsed),
      ...(resolutionUsed ? { resolutionUsed } : {}),
      ...(videoModeUsed ? { videoModeUsed } : {}),
    };
  }

  if (job.simpleStoryRender && typeof job.simpleStoryRender === 'object') {
    // sections[].url are real storage references, not narration text, but
    // still not something the agent needs to reason about — only whether
    // rendering is done and roughly how far along it is (same "pass/fail
    // state, not raw data" reasoning as every other generated-media field
    // above). audioUrlSnapshot/subtitlesContentSnapshot are internal
    // bookkeeping (mirrors youtubePackage's generatedFromScript) used only
    // to detect stale progress.
    const { status, sections, totalSections, error } = job.simpleStoryRender;
    const completedSections = Array.isArray(sections) ? sections.filter((section) => section && section.status === 'completed').length : 0;
    summarized.simpleStoryRender = {
      status,
      completedSections,
      ...(typeof totalSections === 'number' ? { totalSections } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (job.referenceVideoAnalysis && typeof job.referenceVideoAnalysis === 'object') {
    // analyzedUrl/analyzedNotes are internal bookkeeping (see
    // analyzeReferenceVideo below) used only to decide whether a fresh
    // Claude call is needed — they just duplicate referenceVideoUrl/
    // referenceVideoNotes already in the summary, so strip them here.
    const { status, summary, error } = job.referenceVideoAnalysis;
    summarized.referenceVideoAnalysis = {
      status,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (job.youtubePackage && typeof job.youtubePackage === 'object') {
    // thumbnailUrl holds a full base64-encoded image (same size concern as
    // images[].url above) — the agent only needs to know whether a
    // thumbnail image exists, not its actual bytes. generatedFromScript is
    // internal bookkeeping (mirrors referenceVideoAnalysis's analyzedUrl/
    // analyzedNotes) used only to decide whether a fresh generation is
    // needed, so it's stripped here too.
    const { status, titles, description, tags, thumbnailConcept, thumbnailText, thumbnailUrl, error } =
      job.youtubePackage;
    summarized.youtubePackage = {
      status,
      ...(Array.isArray(titles) && titles.length ? { titles } : {}),
      ...(description ? { description } : {}),
      ...(Array.isArray(tags) && tags.length ? { tags } : {}),
      ...(thumbnailConcept ? { thumbnailConcept } : {}),
      ...(thumbnailText ? { thumbnailText } : {}),
      ...(error ? { error } : {}),
      hasThumbnailImage: Boolean(thumbnailUrl),
    };
  }

  if (job.subtitles && typeof job.subtitles === 'object') {
    // content is the full .srt file text — could be a few KB for a longer
    // video, same "the agent needs pass/fail state, not the raw bytes"
    // reasoning as every other generated-media field above.
    // generatedFromVoiceoverUrl is internal bookkeeping (mirrors
    // youtubePackage's generatedFromScript) used only to decide whether a
    // fresh transcription is needed.
    const { status, format, content, error } = job.subtitles;
    summarized.subtitles = {
      status,
      ...(format ? { format } : {}),
      ...(error ? { error } : {}),
      hasSubtitles: Boolean(content),
    };
  }

  return summarized;
}

const TOOLS = [
  {
    name: 'getVideoOptions',
    description:
      'Get the available active video production options: languages, durations, video styles, story/video types, voice-over options, visual styles, and output options.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'updateVideoJob',
    description:
      'Update the current video production job with details gathered or changed during the conversation. Only include the fields being set.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        videoTitle: { type: 'string' },
        duration: { type: 'string' },
        language: { type: 'string' },
        storyStyle: { type: 'string' },
        script: { type: 'string' },
        scenes: { type: 'array', items: {} },
        characters: { type: 'array', items: {} },
        // Must be plain strings: both feed a real paid API call downstream
        // as raw text (image-generation.js's prompt, runway.js's
        // promptText) with no defensive coercion — unlike characters/
        // scenes, which are already handled either way. Allowing objects
        // here (the previous `items: {}`) let the Agent set videoPrompts
        // to something Runway's own validation then rejected with
        // "promptText: Invalid input: expected string, received object" —
        // a real, paid, avoidable failure.
        imagePrompts: { type: 'array', items: { type: 'string' } },
        videoPrompts: { type: 'array', items: { type: 'string' } },
        // Constrained to the project's actual voice-over options (plus
        // 'none') so this can never silently drift to an unsupported value
        // that voiceover-generation.js's VOICE_MAP would then just fall
        // back to a default voice for, without telling anyone.
        voiceStyle: { type: 'string', enum: [...VOICE_STYLE_OPTIONS, 'none'] },
        // Optional "Reference Video / Inspiration Mode" — see
        // backend/reference-video.js. Setting referenceVideoUrl alone does
        // NOT trigger analysis; call analyzeReferenceVideo separately once
        // both are set the way the user wants.
        referenceVideoUrl: { type: 'string' },
        referenceVideoNotes: { type: 'string' },
        // Optional background-music mixing — see assembleFinalVideo below
        // and backend/music-library.js. Default off (musicEnabled: false);
        // this app never downloads or generates music, only mixes in a
        // local file. musicTrack picks a track from the user-populated
        // data/music/ library (getVideoOptions' musicTrackOptions);
        // musicCustomUrl is an alternative one-off track (a data: URI or
        // local path) not in that shared library, and takes priority over
        // musicTrack when both are set.
        musicEnabled: { type: 'boolean' },
        // An empty enum array is invalid JSON Schema, so only constrain
        // this when the local library actually has at least one track —
        // with none configured (the default), any string is technically
        // accepted here but the system prompt above already tells the
        // Agent musicTrackOptions is empty and not to invent one.
        musicTrack: MUSIC_TRACK_OPTIONS.length > 0 ? { type: 'string', enum: MUSIC_TRACK_OPTIONS } : { type: 'string' },
        musicCustomUrl: { type: 'string' },
        thumbnail: { type: 'string' },
        description: { type: 'string' },
        // Optional "YouTube Publishing Package" toggle — see
        // generateYoutubePackage below. Default false; set this true when
        // the user checks the "Generate YouTube Package" option, or right
        // before calling generateYoutubePackage in response to a direct
        // chat request, so the choice is recorded on the job.
        generateYoutubePackage: { type: 'boolean' },
        // Optional "burn captions into the final MP4" toggle — see
        // generateSubtitles/assembleFinalVideo below. Default false; the
        // real .srt subtitles file is still generated and available either
        // way. Set this true when the user asks for burned-in/hardcoded
        // captions rather than a separate downloadable caption file.
        burnInSubtitles: { type: 'boolean' },
        // Which shape the video renders at throughout image generation,
        // Runway video generation, and final assembly. Optional — defaults
        // to 'horizontal' (16:9) if never set. Changing this AFTER some
        // scene images/clips already exist forces those scenes to
        // regenerate for real the next time generateSceneImages/
        // generateSceneVideo runs (a wrong-shaped asset is never reused
        // just to save a call).
        outputFormat: { type: 'string', enum: jobStore.OUTPUT_FORMATS },
        // Which resolution tier the FINAL assembled MP4 is exported at —
        // independent of outputFormat (orientation). Optional — defaults to
        // '720p' if never set. This only changes the last ffmpeg pass's
        // output canvas; scene image/video generation is untouched (no
        // extra paid-API cost at any tier). '1080p'/'4k' are a real,
        // honest upscale of that same generated footage — the exported
        // FILE genuinely has those pixel dimensions, but not genuinely
        // higher-detail source video. Never claim sharper source footage
        // when a higher tier is selected — see prompts/system-prompt.md.
        resolutionTier: { type: 'string', enum: jobStore.RESOLUTION_TIERS },
        // Which final-assembly pipeline this job uses. 'cinematic'
        // (default) is the existing Runway-clip pipeline — real, paid
        // Runway/OpenAI image calls per scene. 'simple-story' is a local,
        // FFmpeg-only pipeline for English learning/listening-practice
        // story videos: NO scene images, NO Runway clips, NO paid video
        // call of any kind — large synchronized on-screen story text,
        // Ken Burns backgrounds, and burned-in captions, rendered directly
        // from the script/voice-over/subtitles. Set this BEFORE asset
        // generation begins — switching it after scene images/clips
        // already exist does not delete them, but a 'simple-story' job
        // never uses them and a 'cinematic' job never uses this mode's
        // rendering. See getVideoOptions' videoGenerationModes.
        videoMode: { type: 'string', enum: jobStore.VIDEO_MODES },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'analyzeReferenceVideo',
    description:
      'Analyze the current job\'s referenceVideoUrl (and referenceVideoNotes, if set) to extract ONLY ' +
      'general, high-level storytelling format elements — story type/theme, pacing, approximate ' +
      'duration, approximate number/length of scenes, dialogue vs. narration style, visual/camera ' +
      'style, emotional tone, and moral/lesson structure — for use as inspiration when writing a ' +
      'completely new, original script. This is part of the OPTIONAL "Reference Video / Inspiration ' +
      'Mode" — only call it when the user has actually provided a reference video URL (via ' +
      'updateVideoJob\'s referenceVideoUrl) and wants it used; never call it otherwise, and never call ' +
      'it if referenceVideoUrl is empty. Uses only free, keyless YouTube metadata plus whatever ' +
      'referenceVideoNotes the user provided, plus one Claude call to summarize — no Runway/OpenAI ' +
      'call, no new paid service. Refuses with a clear reason if the URL isn\'t a recognizable YouTube ' +
      'link, or if there is no real information to analyze at all (no metadata, no captions, and no ' +
      'notes) — when that happens, ask the user to paste a short synopsis into referenceVideoNotes ' +
      '(via updateVideoJob) rather than guessing. The result (referenceVideoAnalysis.summary) is ' +
      'ONLY a high-level format description — never treat it as, or repeat, the original video\'s ' +
      'actual transcript, dialogue, character names/designs, exact scenes, title, thumbnail, or music. ' +
      'Once you have it, write an entirely original English script/scenes/characters inspired only by ' +
      'that general format, with different characters, appearances, clothing, locations, dialogue, and ' +
      'scene details — then continue the normal production flow exactly as usual. Calling this again ' +
      'with the exact same referenceVideoUrl and referenceVideoNotes as the last successful analysis ' +
      'is a safe no-op that returns the existing analysis unchanged — no extra Claude call is made, so ' +
      'feel free to call it to check the current state without worrying about repeat cost. It only ' +
      'actually re-analyzes when referenceVideoUrl or referenceVideoNotes have changed (set via ' +
      'updateVideoJob) since the last successful analysis.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'generateSceneImages',
    description:
      'Generate the real scene images for the current video job from its existing imagePrompts and ' +
      'characters, using the same image-generation backend the rest of this app already uses. Refuses ' +
      'outright — no OpenAI call is made — if the job\'s videoMode is \'simple-story\' (Simple Story ' +
      'Video mode never uses scene images; go straight to generateVoiceover/generateSubtitles/' +
      'assembleFinalVideo instead). Before ' +
      'calling this, set BOTH imagePrompts AND videoPrompts via updateVideoJob together — one ' +
      'videoPrompt (a short motion/camera description) per imagePrompt, in the same scene order — ' +
      'even though this tool only generates images. Scene video generation later needs a matching ' +
      'videoPrompt for the same scene, and preparing it only after images already exist wastes a full ' +
      'round trip; this tool refuses to run at all until both are set with matching lengths. Any ' +
      'imagePrompt that already has a completed image is skipped automatically and is never ' +
      'regenerated or charged again — UNLESS the job\'s outputFormat has changed since that image was ' +
      'generated, in which case it is regenerated for real at the new shape (a wrong-shaped image is ' +
      'never kept just to save a call). This can take a little while; let the user know generation is in ' +
      'progress. Only tell the user images were generated if this tool reports them as completed — ' +
      'report any failures honestly instead of assuming success.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'advanceVideoJobStage',
    description:
      'Move the current video production job to its next production stage ' +
      '(NEW -> SCRIPTING -> SCENE PLANNING -> ASSET GENERATION -> EDITING -> READY -> COMPLETED). ' +
      'The job cannot advance into COMPLETED unless it has already been confirmed by the user. ' +
      'It also cannot leave SCRIPTING without a complete script (a short fragment is not enough), ' +
      'leave SCENE PLANNING without non-empty scenes and characters, leave ASSET GENERATION ' +
      'without non-empty imagePrompts and videoPrompts, or leave READY without a real, ' +
      'successfully rendered final video file. Once every scene\'s video clip is completed, call ' +
      'assembleFinalVideo first — this reports finalVideo missing if that has not been done yet. ' +
      'When it reports finalVideo missing, tell the user plainly that the final video is not ' +
      'assembled/available yet and their job stays at the READY stage; never say the video has ' +
      'been produced, rendered, or completed until assembleFinalVideo actually reports it completed.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'confirmVideoJob',
    description:
      'Record that the user has given explicit, unambiguous confirmation of the final video ' +
      'production summary. Only call this immediately after the user clearly confirms ' +
      '(e.g. "yes", "confirmed", "approved", "go ahead"). Never call this for ambiguous, ' +
      'partial, or unclear replies.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'generateSceneVideo',
    description:
      'Generate a REAL, PAID Runway video clip for exactly one scene of the current video job, ' +
      'using the same provider-independent video-generation backend the rest of this app already ' +
      'uses. Refuses outright — no Runway call is made — if the job\'s videoMode is \'simple-story\' ' +
      '(Simple Story Video mode never uses Runway; go straight to generateVoiceover/generateSubtitles/' +
      'assembleFinalVideo instead). This costs real Runway credits — only call this when the user has explicitly asked, ' +
      'right now, to generate video for a specific scene. Never call this automatically after ' +
      'generating images, and never call it again to retry a scene that already FAILED unless the ' +
      'user explicitly asks again. IMPORTANT exception: if the scene\'s status is "processing" ' +
      '(Runway accepted the request and is still rendering), calling this again is a FREE, SAFE ' +
      'status check, never a new paid submission — the backend only re-submits a scene whose status ' +
      'is not_started or failed, and a processing scene is only polled. Feel free to call this again ' +
      'to check on a processing scene whenever the user asks for an update, without needing to ask ' +
      'their permission first for that specific check. sceneIndex is REQUIRED: it is the zero-based scene number to ' +
      'generate (0 for "Scene 1", 1 for "Scene 2", etc.) — every other scene in the job is left ' +
      'completely untouched and is never submitted to Runway, so calling this with sceneIndex 0 can ' +
      'never trigger Scene 2 or any other scene. Because sceneIndex already limits every call to one ' +
      'scene, this works for a job with ANY number of scenes, including a genuine single-scene job — ' +
      `never split or restructure the user's story into ${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes just ` +
      'to satisfy a scene-count requirement; there is none when sceneIndex is used. (A full-job run ' +
      `that omits sceneIndex — never do this from the conversation — is capped to exactly ` +
      `${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes for controlled live testing; that limit is irrelevant ` +
      'here since sceneIndex is always required.) If this reports that imagePrompts/videoPrompts are ' +
      'missing or mismatched, fix it yourself with updateVideoJob (never ask the user to manually edit ' +
      'job data) and only then try again — that is preparing prerequisite data, not retrying a failed ' +
      'paid call. Only tell the user a clip was generated if this tool reports that scene as completed ' +
      '— report a failure or still-processing result honestly instead of assuming success. The clip is ' +
      'rendered at the job\'s outputFormat (horizontal 16:9 / vertical 9:16 / square 1:1, default ' +
      'horizontal) — if outputFormat changes after a scene\'s clip already completed, calling this again ' +
      'submits a real, fresh Runway request at the new shape rather than keeping the old, now wrong-' +
      'shaped clip.',
    input_schema: {
      type: 'object',
      properties: {
        sceneIndex: { type: 'integer', minimum: 0 },
      },
      required: ['sceneIndex'],
      additionalProperties: false,
    },
  },
  {
    name: 'generateVoiceover',
    description:
      'Generate a REAL, PAID OpenAI text-to-speech voice-over narrating the current job\'s script, ' +
      'using the exact same voice-over backend the Final Review "Generate Voice-over" button already ' +
      'uses. This costs real OpenAI credits — only call this when the user has explicitly asked, right ' +
      'now, to generate or regenerate the voice-over. Optionally pass voiceStyle to set (or change) ' +
      'which voice is used before generating in the same call — e.g. the user saying "use Female Warm ' +
      'voice" or "change the voice to Neutral Narrator" should call this with that voiceStyle right ' +
      'away. If the user only wants to change the voice preference WITHOUT generating yet, use ' +
      'updateVideoJob instead and do not call this. Omitting voiceStyle keeps whatever voice is ' +
      'already set. Every call re-generates the voice-over from the current script from scratch — ' +
      'there is no "already done, skip it" behavior here (unlike scene images/video) — so calling this ' +
      'again is exactly how "regenerate the voice-over with a different voice" works, not a wasted ' +
      'duplicate call. Requires a real, complete script and a voice style other than "no voice-over" — ' +
      'refuses first, before any paid call, if either is missing, and tells you exactly what to fix ' +
      '(never ask the user to fix job data manually). If a final video was already assembled, a ' +
      'successful new voice-over resets it so it must be assembled again with assembleFinalVideo before ' +
      'the fresh narration is actually reflected in the final MP4 — tell the user this if it applies. ' +
      'Only tell the user the voice-over was generated if this reports it as completed.',
    input_schema: {
      type: 'object',
      properties: {
        voiceStyle: { type: 'string', enum: VOICE_STYLE_OPTIONS },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembleFinalVideo',
    description:
      'Combine every already-completed scene video clip (plus the existing voice-over audio, if one ' +
      'has been generated) into one real, playable final MP4 for the current job, using local ffmpeg ' +
      'processing only. This calls NO paid API — every clip and the voice-over were already generated ' +
      'and paid for earlier — so, unlike generateSceneVideo/generateSceneImages, you do not need to ' +
      'ask the user for permission before calling this. If the job\'s videoMode is \'simple-story\', ' +
      'this instead renders that mode\'s local, FFmpeg-only pipeline (see backend/simple-story-video.js) ' +
      'straight from the script/voice-over/subtitles — no scene clips involved at all, no Runway call ' +
      'ever, large synchronized on-screen story text plus burned-in captions, fixed at 1080p 16:9. It ' +
      'requires a completed voice-over AND completed subtitles (call generateVoiceover then ' +
      'generateSubtitles first) and refuses with a clear reason if either is missing. A real long story ' +
      '(16+ sections) can take longer to fully render than one call safely allows, so this may return ' +
      'finalVideo.status \'processing\' with a completedSections/totalSections count instead of ' +
      '\'completed\' on this call — that is normal progress, never a failure: tell the user rendering ' +
      'has started and is continuing in the background (the app keeps advancing it automatically), never ' +
      'call this again yourself just to push it further along. The rest of this ' +
      'description (scene clips, outputFormat, burnInSubtitles, music, resolutionTier) describes the ' +
      'default \'cinematic\' Runway pipeline only. For a \'cinematic\' job: requires every scene\'s video clip to already ' +
      'be completed; if any scene is missing or not yet completed, this refuses with a clear reason — ' +
      'generate the missing scene(s) with generateSceneVideo and try again, never ask the user to fix ' +
      'it manually. If there is no voice-over yet, the final video is produced silently (video only), ' +
      'which is expected, not a failure. The output is sized to the job\'s outputFormat (horizontal ' +
      '16:9 / vertical 9:16 / square 1:1). If burnInSubtitles is on, this ALSO requires real subtitles to ' +
      'already exist (call generateSubtitles first) and burns them into the video — it refuses rather ' +
      'than producing a caption-less video that silently doesn\'t match that setting. Calling this again ' +
      'is a safe no-op that returns the existing final video unchanged ONLY while it still matches the ' +
      'current burnInSubtitles/subtitles/music/resolutionTier state — turning burnInSubtitles on/off, ' +
      'regenerating subtitles, changing the music settings, or changing resolutionTier, after a final ' +
      'video already exists makes the next call here re-assemble for real (still no paid API call) to ' +
      'keep it in sync. If musicEnabled is on (see updateVideoJob), this loops/trims a local music track ' +
      '(musicTrack from the user-populated local library, or musicCustomUrl for a one-off track) to the ' +
      'video\'s length, fades it in/out, and mixes it in quietly ducked under the voice-over (or at a ' +
      'fuller standalone level with no voice-over) — this is entirely optional and off by default, uses ' +
      'only local ffmpeg processing (no paid API, no downloaded/generated music), and refuses with a ' +
      'clear error rather than silently skipping music if the selected track is missing or unreadable. ' +
      'resolutionTier (see updateVideoJob) controls the exported file\'s real pixel dimensions — ' +
      '\'720p\' (default, unchanged from before this setting existed), \'1080p\', or \'4k\', at whichever ' +
      'aspect ratio outputFormat selects. This ONLY upscales the same already-generated scene footage in ' +
      'this local ffmpeg pass — it never requests higher-resolution images/video from any provider, so ' +
      'there is no extra paid-API cost at any tier. Tell the user plainly that \'1080p\'/\'4k\' are a real ' +
      'upscale of the same source footage (the file\'s dimensions genuinely match the tier), NOT sharper ' +
      'or more detailed source video — never imply 4k means the scenes themselves were captured/generated ' +
      'at higher detail. Only tell the user the final video is ready if this reports it as completed. A ' +
      'title/description/tags/thumbnail package can be generated separately (see generateYoutubePackage ' +
      'below), but actually publishing/uploading the video to YouTube itself is still not implemented — ' +
      'never claim a video was published or uploaded. For a \'simple-story\' job, if the user asks for ONE ' +
      'targeted visual/audio change after a video already exists (a different background color, on-screen ' +
      'text size/position/color, subtitle timing, or voice-over speed/volume), use updateVideoEditSettings ' +
      'first, then call this again to apply it — never re-generate the script/voice-over/subtitles/images ' +
      'for a change like that.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'updateVideoEditSettings',
    description:
      'For a \'simple-story\' job ONLY: apply ONE targeted, purely LOCAL visual/audio edit to how the ' +
      'final video is rendered, WITHOUT regenerating the script, voice-over, subtitles, images, or ' +
      'thumbnail, and WITHOUT any paid API call — this only ever runs local ffmpeg processing on assets ' +
      'already generated (and already paid for) earlier. Only include the field(s) the user actually ' +
      'asked to change; every other field keeps its current value. After calling this, call ' +
      'assembleFinalVideo to actually re-render the video with the new setting(s) — updating the setting ' +
      'alone does not touch the existing final video file. Refuses with a clear reason for a \'cinematic\' ' +
      'job (this only applies to Simple Story Video mode\'s own rendering — see assembleFinalVideo). Pass ' +
      'the string "default" for backgroundColor/storyPosition/fontWeight/subtitleColor to reset that one ' +
      'field back to its original built-in look; numeric fields reset the same way by passing their own ' +
      'default value (subtitleFontScale: 1, subtitleTimingOffsetMs: 0, voiceSpeed: 1, voiceVolumeDb: 0). ' +
      'backgroundColor: a single solid hex color (e.g. "1a2a4a" for navy — no "#") used for EVERY section, ' +
      'replacing the default rotating color palette. storyPosition: "top"/"center"(default)/"bottom" for ' +
      'the large on-screen story text only — the small caption line always stays at the bottom, standard ' +
      'subtitle placement, and is unaffected. fontWeight: "bold" or "regular" for both the story and ' +
      'caption text — the only two weights this app\'s bundled font supports (never claim a different font ' +
      'FAMILY can be applied; that would require a new font file this app does not have). ' +
      'subtitleFontScale: a multiplier (0.5-2.0) on BOTH text elements\' built-in sizes — e.g. 1.3 for ' +
      '"make the text bigger". subtitleColor: a hex color (no "#") for both text elements, default white. ' +
      'subtitleTimingOffsetMs: shifts every subtitle\'s timing by this many milliseconds (-10000 to 10000, ' +
      'positive = later) without touching the audio at all — use this for "the captions are out of sync" ' +
      'requests. voiceSpeed: a playback-speed multiplier (0.5-2.0, e.g. 0.9 for 10% slower) applied ' +
      'LOCALLY to the existing voice-over audio via ffmpeg — never a new text-to-speech call; on-screen ' +
      'text timing is automatically rescaled to stay in sync with the new speed. voiceVolumeDb: a decibel ' +
      'gain/cut (-30 to 30, e.g. 6 for noticeably louder, -6 for quieter) applied LOCALLY the same way. ' +
      'None of these fields ever require the user\'s confirmation before calling this — they are all free, ' +
      'local edits — but if the user instead asks for something this cannot do locally (a different VOICE ' +
      'or a re-written script, for example), tell them that requires generateVoiceover (a real, paid ' +
      'OpenAI call) and get their explicit confirmation before calling that, exactly as generateVoiceover\'s ' +
      'own description already requires — never call it just to satisfy an edit request like this one.',
    input_schema: {
      type: 'object',
      properties: {
        backgroundColor: { type: 'string' },
        storyPosition: { type: 'string', enum: ['top', 'center', 'bottom', 'default'] },
        fontWeight: { type: 'string', enum: ['regular', 'bold', 'default'] },
        subtitleFontScale: { type: 'number', minimum: 0.5, maximum: 2.0 },
        subtitleColor: { type: 'string' },
        subtitleTimingOffsetMs: { type: 'integer', minimum: -10000, maximum: 10000 },
        voiceSpeed: { type: 'number', minimum: 0.5, maximum: 2.0 },
        voiceVolumeDb: { type: 'number', minimum: -30, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'generateYoutubePackage',
    description:
      'Generate an OPTIONAL YouTube publishing package for the current job — 3 title options, an ' +
      'SEO-friendly description, relevant tags, a thumbnail concept/text, and (when the image ' +
      'generation provider is configured) an original 16:9 thumbnail image — based ONLY on this job\'s ' +
      'own final script/topic/style, never on any reference video. This is entirely optional: only call ' +
      'it when the job\'s generateYoutubePackage setting is turned on (see updateVideoJob), OR the user ' +
      'has directly asked, right now, for a title/description/thumbnail/YouTube package to be created ' +
      '(e.g. "create the title, description and thumbnail for this video") — if they ask directly while ' +
      'the setting is still off, call updateVideoJob to turn generateYoutubePackage on first so the ' +
      'choice is recorded, then call this. Never call it automatically otherwise, and never call it ' +
      'before a real, complete script exists — it refuses with a clear reason if the script is missing ' +
      'or incomplete. This costs a real Claude call, plus a real OpenAI image call for the thumbnail ' +
      'image if OPENAI_API_KEY is configured — both reuse the exact same providers already used ' +
      'elsewhere in this app, not a new paid service. Calling this again with the exact same script as ' +
      'the last successfully generated package is a free no-op that returns the existing package ' +
      'unchanged; pass forceRegenerate: true if the user explicitly asks to regenerate/redo it even ' +
      'though the script hasn\'t changed (e.g. "give me different title options"). If a Reference Video ' +
      'URL was used for storytelling-format inspiration, this package is still based only on the new ' +
      'original script — never the reference video\'s own title, thumbnail, wording, characters, ' +
      'artwork, or composition. Only tell the user the package was generated if this reports it as ' +
      'completed — report a failure honestly instead of assuming success, and note if only the ' +
      'thumbnail image failed while the rest succeeded.',
    input_schema: {
      type: 'object',
      properties: {
        forceRegenerate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'generateSubtitles',
    description:
      'Generate a real, accurate .srt subtitle file for the current job by transcribing its ALREADY-' +
      'GENERATED voice-over audio — never guessed or estimated from the script\'s text or length. ' +
      'Requires a real, completed voice-over to already exist; refuses with a clear reason if there is ' +
      'none yet (call generateVoiceover first — never call generateVoiceover yourself just to satisfy ' +
      'this, only when the user has actually asked for a voice-over) or if the job is set to no voice-' +
      'over at all. This costs a real OpenAI transcription call — it reuses the exact same OPENAI_API_KEY ' +
      'already used for the voice-over/images, not a new paid service, but it is billed separately from ' +
      'those. Calling this again with the exact same, unchanged voice-over audio is a free no-op that ' +
      'returns the existing subtitles unchanged (the same audio always transcribes the same way, so this ' +
      'never loses accuracy) — a real, fresh voice-over (a different url) always triggers a real, fresh ' +
      'transcription automatically, and generateVoiceover succeeding also resets any existing subtitles ' +
      'so stale captions from the previous narration are never kept around. Pass forceRegenerate: true ' +
      'only if the user explicitly wants a transcription redone despite nothing having changed. The .srt ' +
      'file itself is always the deliverable; separately, updateVideoJob\'s burnInSubtitles setting ' +
      'controls whether assembleFinalVideo also hardcodes these exact captions into the final MP4\'s own ' +
      'video — the .srt stays the single source of truth either way. Only tell the user subtitles were ' +
      'generated if this reports it as completed — report a failure honestly instead of assuming success.',
    input_schema: {
      type: 'object',
      properties: {
        forceRegenerate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
];

async function executeTool(name, jobId, input) {
  if (name === 'getVideoOptions') {
    return VIDEO_OPTIONS;
  }

  if (name === 'updateVideoJob') {
    const updates = {};
    for (const field of UPDATABLE_JOB_FIELDS) {
      if (input && Object.prototype.hasOwnProperty.call(input, field)) {
        updates[field] = input[field];
      }
    }
    const job = await jobStore.updateJob(jobId, updates);
    return JSON.stringify(job ? summarizeJobForAgent(job) : { error: 'job not found' });
  }

  if (name === 'analyzeReferenceVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    if (!job.referenceVideoUrl || !job.referenceVideoUrl.trim()) {
      return JSON.stringify({
        error: 'referenceVideoUrl is not set yet. Use updateVideoJob to set it first (only if the user actually provided a reference video URL).',
      });
    }

    const currentUrl = job.referenceVideoUrl.trim();
    const currentNotes = typeof job.referenceVideoNotes === 'string' ? job.referenceVideoNotes.trim() : '';
    const existingAnalysis = job.referenceVideoAnalysis;

    // Never re-spend a real Claude call analyzing the exact same reference
    // video/notes that were already successfully analyzed — return the
    // existing result unchanged instead. A failed or pending analysis is
    // NOT cached here (it always re-tries), only a completed one; changing
    // referenceVideoUrl or referenceVideoNotes (via updateVideoJob) is what
    // forces a fresh analysis.
    if (
      existingAnalysis &&
      existingAnalysis.status === 'completed' &&
      existingAnalysis.analyzedUrl === currentUrl &&
      (existingAnalysis.analyzedNotes || '') === currentNotes
    ) {
      return JSON.stringify(summarizeJobForAgent(job));
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return JSON.stringify({
        error:
          'Reference video analysis is not configured on the server right now. Tell the user this is ' +
          'temporarily unavailable — do not say the video was analyzed.',
      });
    }

    try {
      const analysisResult = await referenceVideo.analyzeReferenceVideo({
        referenceVideoUrl: job.referenceVideoUrl,
        referenceVideoNotes: job.referenceVideoNotes,
      });
      // Record exactly which URL/notes this result belongs to, so a later
      // call can tell whether the input has actually changed.
      const referenceVideoAnalysis = { ...analysisResult, analyzedUrl: currentUrl, analyzedNotes: currentNotes };
      const updatedJob = await jobStore.updateJob(jobId, { referenceVideoAnalysis });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error analyzing reference video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Reference video analysis failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'generateSceneImages') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const paidVisualBlocker = findPaidVisualGenerationBlocker(job, 'scene image generation');
    if (paidVisualBlocker) {
      return JSON.stringify({ error: paidVisualBlocker });
    }

    const promptMismatch = findScenePromptMismatch(job);
    if (promptMismatch) {
      return JSON.stringify({ error: promptMismatch });
    }

    if (!process.env.OPENAI_API_KEY) {
      return JSON.stringify({
        error:
          'Image generation is not configured on the server right now. Tell the user image ' +
          'generation is temporarily unavailable — do not say images were generated.',
      });
    }

    try {
      // Reuses the exact same image-generation implementation the REST
      // route already uses (backend/image-generation.js) — no second
      // image-generation system. That function already skips any prompt
      // that has a completed entry in existingImages, so an already-
      // generated scene is never regenerated or charged again.
      const images = await imageGeneration.generateImagesForPrompts({
        imagePrompts: job.imagePrompts,
        characters: job.characters,
        existingImages: job.images,
        outputFormat: job.outputFormat,
        jobId: job.id,
      });
      const updatedJob = await jobStore.updateJob(jobId, { images });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating images (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Image generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'advanceVideoJobStage') {
    const result = await jobStore.advanceJob(jobId);

    if (result.error === 'not_found') {
      return JSON.stringify({ error: 'job not found' });
    }

    const job = summarizeJobForAgent(result.job);

    if (result.error === 'confirmation_required') {
      return JSON.stringify({
        error:
          'The job cannot be completed until the user has explicitly confirmed the final production summary.',
        job,
      });
    }
    if (result.error === 'missing_required_output') {
      const isRenderingBlock = result.missingFields.includes('finalVideo');
      return JSON.stringify({
        error: isRenderingBlock
          ? 'The job cannot be marked COMPLETED because no real, assembled final video exists yet. ' +
            'Call assembleFinalVideo once every scene\'s video clip is completed — tell the user ' +
            'their video is not produced/rendered yet and the job stays at the READY stage until ' +
            'that succeeds. Do not call updateVideoJob for this; it cannot be filled in manually.'
          : `The job cannot advance out of ${result.job.status} because the following required output is missing or empty: ` +
            `${result.missingFields.join(', ')}. Use updateVideoJob to fill these in first.`,
        missingFields: result.missingFields,
        job,
      });
    }
    if (result.error === 'no_next_stage') {
      return JSON.stringify({ error: 'job has no next stage', job });
    }

    return JSON.stringify(job);
  }

  if (name === 'confirmVideoJob') {
    const job = await jobStore.updateJob(jobId, { confirmed: true });
    return JSON.stringify(job ? summarizeJobForAgent(job) : { error: 'job not found' });
  }

  if (name === 'generateSceneVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const paidVisualBlocker = findPaidVisualGenerationBlocker(job, 'Runway video generation');
    if (paidVisualBlocker) {
      return JSON.stringify({ error: paidVisualBlocker });
    }

    const promptMismatch = findScenePromptMismatch(job);
    if (promptMismatch) {
      return JSON.stringify({ error: promptMismatch });
    }

    const sceneIndex = input && input.sceneIndex;

    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= job.videoPrompts.length) {
      return JSON.stringify({
        error:
          `sceneIndex must be an integer between 0 and ${job.videoPrompts.length - 1} for this job. ` +
          'No Runway request was made.',
      });
    }

    // The TEMPORARY safety cap on POST /api/jobs/:id/generate-video (see
    // TEMP_GENERATE_VIDEO_SCENE_CAP above) exists to bound a full-job run
    // (no sceneIndex) to a couple of paid requests at once. It does not
    // apply here: sceneIndex is REQUIRED for this tool (enforced by its
    // input_schema and re-checked above), so every call is already bounded
    // to exactly one paid provider request no matter how many scenes the
    // job has — including a genuine single-scene job.

    if (!Array.isArray(job.images) || job.images.length === 0) {
      return JSON.stringify({
        error: 'job has no generated scene images yet — generate images before generating video',
      });
    }

    const activeProvider = videoGeneration.getProvider();

    if (activeProvider.name === 'runway' && !process.env.RUNWAYML_API_SECRET) {
      return JSON.stringify({
        error:
          'Video generation is not configured on the server right now. Tell the user video ' +
          'generation is temporarily unavailable — do not say a clip was generated.',
      });
    }

    try {
      // Reuses the exact same video-generation implementation the REST
      // route already uses (backend/video-generation.js) — no second
      // video-generation system. sceneIndex restricts this call to exactly
      // one scene; every other scene's existing clip state is carried
      // through untouched (see generateVideoForScenes), so this can never
      // submit any scene other than the one explicitly requested.
      const existingClips =
        job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

      const result = await videoGeneration.generateVideoForScenes({
        videoPrompts: job.videoPrompts,
        images: job.images,
        existingClips,
        sceneIndex,
        outputFormat: job.outputFormat,
      });

      const allCompleted = result.clips.length > 0 && result.clips.every((clip) => clip.status === 'completed');
      const anyProcessing = result.clips.some((clip) => clip.status === 'processing');
      const anyFailed = result.clips.some((clip) => clip.status === 'failed');
      const overallStatus = allCompleted
        ? 'completed'
        : anyProcessing
        ? 'processing'
        : anyFailed
        ? 'failed'
        : 'not_started';

      const videoGenerationField = {
        provider: activeProvider.name,
        status: overallStatus,
        clips: result.clips,
        error: overallStatus === 'failed' ? 'One or more scenes failed to generate a video clip.' : null,
      };

      // finalVideo is never set here — many separate scene clips are not
      // one final assembled video (see the /generate-video route and
      // job-store.js's finalVideo comment). The COMPLETED gate is untouched.
      const updatedJob = await jobStore.updateJob(jobId, { videoGeneration: videoGenerationField });

      const sceneClip = result.clips[sceneIndex];
      return JSON.stringify({
        job: updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' },
        requestedScene: sceneIndex,
        // Mirrors summarizeJobForAgent's own clip shape — status/error only,
        // never the clip URL or externalJobId, consistent with how every
        // other generated asset is reported back to the conversation.
        sceneResult: sceneClip
          ? { status: sceneClip.status, ...(sceneClip.error ? { error: sceneClip.error } : {}) }
          : null,
      });
    } catch (error) {
      console.error(
        'Unexpected error generating video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Video generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'generateVoiceover') {
    let job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    // Setting the voice preference and generating are one tool call when
    // the user names a voice (e.g. "use Female Warm voice") — updateJob
    // returns the updated job directly, so every check below (script
    // length, voiceStyle !== 'none') already sees the new voiceStyle.
    if (input && typeof input.voiceStyle === 'string' && input.voiceStyle) {
      job = await jobStore.updateJob(jobId, { voiceStyle: input.voiceStyle });
    }

    const blocker = findVoiceoverBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    if (!process.env.OPENAI_API_KEY) {
      return JSON.stringify({
        error:
          'Voice-over generation is not configured on the server right now. Tell the user voice-over ' +
          'generation is temporarily unavailable — do not say a voice-over was generated.',
      });
    }

    try {
      // Reuses the exact same voice-over implementation the REST route
      // already uses (backend/voiceover-generation.js) — no second
      // voice-over system.
      const voiceover = await voiceoverGeneration.generateVoiceover({
        script: job.script,
        voiceStyle: job.voiceStyle,
        jobId: job.id,
        storyStyle: job.storyStyle,
        videoMode: job.videoMode,
        topic: job.topic,
      });

      const updates = { voiceover };
      if (voiceover.status === 'completed') {
        // A fresh voice-over invalidates any already-assembled final video
        // — it was combined from whatever narration (or silence) existed
        // before, and no longer reflects this new one. Resetting finalVideo
        // here means assembleFinalVideo's own "already completed, skip"
        // check never keeps serving a stale, out-of-sync video afterward.
        updates.finalVideo = {
          url: null,
          status: 'pending',
          subtitlesUsed: null,
          musicUsed: null,
          resolutionUsed: null,
          videoModeUsed: null,
          editSettingsUsed: null,
        };
        // Any already-rendered Simple Story Video sections were rendered
        // from the PREVIOUS narration audio's own timing and no longer
        // match this new one — resetting this alongside finalVideo means a
        // fresh voice-over never resumes stale section progress (see
        // continueSimpleStoryVideoAssembly's own staleness check, which
        // would also catch this on its own since audioUrlSnapshot no
        // longer matches, but resetting here keeps the job's own record
        // honest immediately rather than only at the next assembly call).
        updates.simpleStoryRender = {
          status: 'not_started',
          totalSections: null,
          sections: [],
          audioUrlSnapshot: null,
          subtitlesContentSnapshot: null,
          editSettingsSnapshot: null,
          error: null,
        };
        // Existing subtitles were transcribed from the PREVIOUS narration
        // audio and no longer match this new one — resetting them here
        // means generateSubtitles never serves stale captions, and
        // findSubtitlesBlocker correctly requires a fresh transcription.
        updates.subtitles = { status: 'pending', format: 'srt', content: null, error: null, generatedFromVoiceoverUrl: null };
      }

      const updatedJob = await jobStore.updateJob(jobId, updates);
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating voice-over (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Voice-over generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'assembleFinalVideo') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    // Already assembled AND still accurate (reflects the job's current
    // burnInSubtitles/subtitles state) — return the existing result
    // unchanged rather than re-running ffmpeg. Not a paid-cost concern like
    // the image/video providers, but still real, non-trivial local compute,
    // and re-assembling would otherwise silently replace a job's real final
    // video with a fresh one whenever the Agent is asked about it again. A
    // STALE result (subtitles turned on/off or regenerated since) is never
    // served — see isFinalVideoStillAccurate.
    if (isFinalVideoStillAccurate(job)) {
      return JSON.stringify(summarizeJobForAgent(job));
    }

    const blocker = findFinalVideoBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    try {
      // Reuses the exact same assembly + storage implementation the REST
      // route already uses (backend/video-assembly.js, backend/
      // video-storage.js) — no second assembly system. Calls no paid API:
      // every clip and the voice-over were already generated (and, for the
      // clips, already paid for) earlier.
      const desiredSubtitlesContent =
        job.burnInSubtitles && job.subtitles && job.subtitles.status === 'completed' ? job.subtitles.content : null;
      const desiredMusicUsed = computeDesiredMusicUsed(job);
      const desiredResolutionUsed = computeDesiredResolutionUsed(job);
      const desiredVideoModeUsed = computeDesiredVideoModeUsed(job);
      const { finalVideo, simpleStoryRender } = await assembleAndStoreFinalVideo(
        job,
        jobId,
        desiredSubtitlesContent,
        desiredMusicUsed,
        desiredResolutionUsed,
        desiredVideoModeUsed
      );
      const updatedJob = await jobStore.updateJob(jobId, { finalVideo, simpleStoryRender });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error assembling final video (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Final video assembly failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'updateVideoEditSettings') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    if ((job.videoMode || jobStore.DEFAULT_VIDEO_MODE) !== 'simple-story') {
      return JSON.stringify({
        error:
          "updateVideoEditSettings only applies to Simple Story Video mode's own rendering — this job's " +
          "videoMode is 'cinematic'. There is no equivalent local-edit capability for the cinematic " +
          'pipeline yet.',
      });
    }

    // Only string fields need a "default" sentinel (see the tool
    // description) — the numeric fields reset the same way by passing
    // their own real default value, so no sentinel parsing is needed for
    // them. Invalid hex colors are refused with a clear, actionable error
    // rather than silently falling back to a default the user never asked
    // for (normalizeVideoEditSettings itself is more lenient, since it also
    // has to tolerate a legacy/never-touched job record).
    const patch = {};
    const stringFields = ['backgroundColor', 'storyPosition', 'fontWeight', 'subtitleColor'];
    const hexFields = ['backgroundColor', 'subtitleColor'];
    for (const field of stringFields) {
      if (typeof input?.[field] !== 'string') {
        continue;
      }
      if (input[field].toLowerCase() === 'default') {
        patch[field] = null;
        continue;
      }
      if (hexFields.includes(field) && !simpleStoryVideo.HEX_COLOR_RE.test(input[field])) {
        return JSON.stringify({
          error: `${field} must be a 6-digit hex color with no "#" (e.g. "1a2a4a"), or "default" to reset — convert the requested color to hex first.`,
        });
      }
      patch[field] = input[field];
    }
    for (const field of ['subtitleFontScale', 'subtitleTimingOffsetMs', 'voiceSpeed', 'voiceVolumeDb']) {
      if (typeof input?.[field] === 'number') {
        patch[field] = input[field];
      }
    }

    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: 'No valid videoEditSettings field was provided to change.' });
    }

    const normalized = simpleStoryVideo.normalizeVideoEditSettings({ ...job.videoEditSettings, ...patch });
    const updatedJob = await jobStore.updateJob(jobId, { videoEditSettings: normalized });
    return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
  }

  if (name === 'generateYoutubePackage') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const blocker = findYoutubePackageBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return JSON.stringify({
        error:
          'YouTube package generation is not configured on the server right now. Tell the user this is ' +
          'temporarily unavailable — do not say a title/description/thumbnail was generated.',
      });
    }

    try {
      const forceRegenerate = Boolean(input && input.forceRegenerate);
      const updatedJob = await runGenerateYoutubePackage(job, jobId, { forceRegenerate });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating YouTube package (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'YouTube package generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  if (name === 'generateSubtitles') {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return JSON.stringify({ error: 'job not found' });
    }

    const blocker = findSubtitlesBlocker(job);
    if (blocker) {
      return JSON.stringify({ error: blocker });
    }

    if (!process.env.OPENAI_API_KEY) {
      return JSON.stringify({
        error:
          'Subtitle generation is not configured on the server right now. Tell the user this is ' +
          'temporarily unavailable — do not say subtitles were generated.',
      });
    }

    try {
      const forceRegenerate = Boolean(input && input.forceRegenerate);
      const updatedJob = await runGenerateSubtitles(job, jobId, { forceRegenerate });
      return JSON.stringify(updatedJob ? summarizeJobForAgent(updatedJob) : { error: 'job not found' });
    } catch (error) {
      console.error(
        'Unexpected error generating subtitles (agent tool):',
        JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
      );
      return JSON.stringify({
        error: 'Subtitle generation failed unexpectedly. Tell the user to try again in a moment.',
      });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// 1mb comfortably covers a real conversation's text (scripts, scene/tool
// history) — realistically tens of KB even for a long one — while still
// catching an oversized payload (e.g. raw image data leaking back into the
// conversation again in the future) with a clear error instead of silently
// accepting multi-MB request bodies.
app.use(express.json({ limit: '1mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON in request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body is too large' });
  }
  next(err);
});
app.use(express.static(path.resolve(__dirname, '..', 'frontend')));
// Serves a locally-assembled final video back out (see
// backend/video-storage.js) — only ever populated in local dev/tests, where
// there is no BLOB_READ_WRITE_TOKEN and the video was written to
// data/generated/ instead of Vercel Blob. In production this directory is
// never written to (Vercel's deployed filesystem is read-only) and this
// route simply serves nothing.
app.use('/generated', express.static(videoStorage.GENERATED_DIR));

// Prompt caching: SYSTEM_PROMPT_BASE (this project's full instructions,
// plus TOOLS — which the API renders immediately before `system` on every
// request) never changes for the life of this process, so it's split into
// its own content block with a cache_control breakpoint at the end. Per
// Anthropic's prefix-caching rules, a breakpoint on the last block of a
// stable prefix caches everything up to it — tools included — so no
// separate marker is needed on TOOLS itself. The per-job summary is a
// second, unmarked block: it changes on every single request (job status,
// script, topic, etc.), so it must never sit inside the cached prefix. A
// top-level function (like executeTool below) purely so this exact request
// shape can be verified without making a live, billed Anthropic call.
function buildCachedSystemPrompt(job) {
  return [
    {
      type: 'text',
      text: SYSTEM_PROMPT_BASE,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        '\n\n## Current Video Production Job\n' +
        'This is the current state of the video production job for this conversation. ' +
        'Use the updateVideoJob, advanceVideoJobStage, and confirmVideoJob tools to keep it accurate.\n\n' +
        JSON.stringify(summarizeJobForAgent(job)),
    },
  ];
}

// Each of these takes long enough (real OpenAI TTS/Whisper calls, or a
// real multi-minute ffmpeg encode for a 15-20 minute Simple Story Video)
// that running more than one inside a single /api/agent request risks the
// serverless function's own time limit — measured directly: a real
// 18-minute voice-over -> subtitles -> final-video chain, all in one
// request, took ~296-300s against a 300s limit, i.e. no safe margin at
// all. The loop below allows at most one of these per request and reports
// autoContinue: true when another is still pending, so the frontend can
// resume the SAME conversation as a fresh, separate request — safely
// inside the time limit — without the user having to type anything.
const HEAVY_TOOLS = new Set(['generateVoiceover', 'generateSubtitles', 'assembleFinalVideo']);

// Chat-to-Video: which tools may never execute on the SAME turn as a
// detected script paste — every real paid call, plus confirmVideoJob
// itself — so the extracted script/settings are always shown to the user
// and explicitly confirmed in a SEPARATE, later message before any of them
// can run. This is a hard, code-level guarantee (see the tool-loop guard
// below), not just a prompt instruction the model could skip under time
// pressure. assembleFinalVideo is deliberately excluded: it calls no paid
// API, and it cannot meaningfully succeed yet anyway (no voice-over/
// subtitles exist on a same-turn paste), so blocking it adds no protection.
const PAID_OR_CONFIRM_TOOLS = new Set([
  'generateVoiceover',
  'generateSubtitles',
  'generateSceneImages',
  'generateSceneVideo',
  'generateYoutubePackage',
  'confirmVideoJob',
]);

// Chat-to-Video: whether THIS request should be treated as the user
// pasting a complete, already-written script (e.g. from ChatGPT) plus
// production instructions, rather than an ordinary chat reply — see the
// "Chat-to-Video" section of prompts/system-prompt.md. Deliberately NOT a
// length/shape heuristic: an ordinary chat message can be arbitrarily
// long (a detailed question, a long clarification), and a real script can
// be short (a 30-second video), so message length alone cannot reliably
// tell the two apart — guessing from it previously caused long ordinary
// messages to be mistaken for scripts. Instead this relies on the
// frontend's explicit "Paste Script" toggle (isScriptPaste in the request
// body), which only reflects the user's own deliberate action for that
// one message — a clear, unambiguous signal that works the same for a
// short or a long script.
function isScriptPasteRequest({ message, isScriptPaste, continueAutomatically }) {
  return !continueAutomatically && Boolean(isScriptPaste) && typeof message === 'string' && message.trim().length > 0;
}

app.post('/api/agent', async (req, res) => {
  const {
    message,
    conversationHistory,
    jobId: requestedJobId,
    continueAutomatically,
    isScriptPaste: isScriptPasteFlag,
  } = req.body || {};

  if (!continueAutomatically && !message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const existingJob = requestedJobId ? await jobStore.getJob(requestedJobId) : null;
  const job = existingJob || (await jobStore.createJob());
  const jobId = job.id;

  // Chat-to-Video: save a detected script paste directly to job.script —
  // BEFORE Claude ever sees this request — so the user's original wording
  // is preserved byte-for-byte and Claude never has to retype or
  // paraphrase a possibly long script back out as tool-call output just to
  // record it (that would cost real output tokens and risk drifting from
  // what the user actually pasted). isScriptPaste also gates the tool-loop
  // guards below: one strips any `script` field Claude's own
  // updateVideoJob call tries to add THIS turn (protecting the just-saved
  // original even if the prompt instruction is ignored), and the other
  // blocks every paid/confirm tool this same turn (see
  // PAID_OR_CONFIRM_TOOLS) so the user always sees the extracted plan and
  // explicitly confirms it in a later message first. Pasting a script that
  // actually differs from an already-confirmed job's current script resets
  // confirmed to false — that earlier confirmation applied to the OLD
  // script, so the new one must be shown and confirmed again before any
  // paid step can run; re-sending the exact same text is a no-op and never
  // un-confirms a job for no reason.
  const isScriptPaste = isScriptPasteRequest({ message, isScriptPaste: isScriptPasteFlag, continueAutomatically });
  if (isScriptPaste) {
    const trimmedScript = message.trim();
    const updates = { script: trimmedScript };
    if (job.confirmed && job.script !== trimmedScript) {
      updates.confirmed = false;
    }
    await jobStore.updateJob(jobId, updates);
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  // A continuation request resumes an already-started turn (its history
  // already ends with the pending tool_use/tool_result exchange) rather
  // than starting a new one, so it must NOT append another user message —
  // Claude's API requires strict user/assistant alternation, and the
  // pending tool_use must be resolved by a tool_result, never followed by
  // a second plain user message.
  const messages = continueAutomatically ? [...history] : [...history, { role: 'user', content: message }];

  async function buildSystemPrompt() {
    const currentJob = await jobStore.getJob(jobId);
    return buildCachedSystemPrompt(currentJob);
  }

  try {
    // 16000 (not the previous 1024) so a full video script — or any other
    // large field — can fit inside a single updateVideoJob tool call
    // without hitting the cap mid-argument. A script cut off by max_tokens
    // either saves as a truncated fragment or drops out of the tool call
    // entirely, which is what caused SCRIPTING's stage gate to report the
    // script as missing/incomplete.
    let response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      // Top-level cache_control auto-places a second breakpoint on the last
      // cacheable block of `messages` (the frontend-resent conversation
      // history), separate from the explicit breakpoint on SYSTEM_PROMPT_BASE
      // above. It composes with that explicit marker (2 of the 4 allowed
      // breakpoints) and defaults to the same 5-minute TTL, so a long
      // conversation's already-seen turns are read from cache instead of
      // re-processed at full price on every follow-up request.
      cache_control: { type: 'ephemeral' },
      system: await buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    let toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
    let heavyToolExecuted = false;
    let deferredHeavyTool = null;

    // Drive this off the actual presence of tool_use blocks, not stop_reason.
    // If a response hits max_tokens (Opus 5 runs adaptive thinking by
    // default, which eats into the output budget) while a tool_use block
    // is already complete, stop_reason won't be 'tool_use' even though an
    // unresolved tool call is sitting in the content — sending that back
    // to the API without its tool_result next produces a 400
    // invalid_request_error ("tool_use ids were found without tool_result
    // blocks immediately after"). Checking the blocks themselves guarantees
    // every tool_use is always paired before the turn is treated as done.
    while (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tool) => {
          // Chat-to-Video: job.script was already saved verbatim from the
          // user's own pasted message above (see isScriptPaste) — never let
          // this turn's updateVideoJob call overwrite it with Claude's own
          // retyped/paraphrased copy, even if it ignores
          // prompts/system-prompt.md's instruction not to include one.
          // Every other field in the same call (duration, language,
          // videoMode, etc.) is unaffected.
          if (
            isScriptPaste &&
            tool.name === 'updateVideoJob' &&
            tool.input &&
            Object.prototype.hasOwnProperty.call(tool.input, 'script')
          ) {
            delete tool.input.script;
          }
          // Chat-to-Video: hard-block every paid tool and confirmVideoJob on
          // the SAME turn as a detected script paste (see
          // PAID_OR_CONFIRM_TOOLS) — the user must see the extracted script
          // receipt and settings and reply with explicit confirmation in a
          // SEPARATE, later message before any of these can run. This is
          // enforced here in code, not just prompted for, so it holds even
          // if the model tries to skip straight to generating or
          // confirming.
          if (isScriptPaste && PAID_OR_CONFIRM_TOOLS.has(tool.name)) {
            return {
              type: 'tool_result',
              tool_use_id: tool.id,
              content: JSON.stringify({
                error: 'blocked_until_user_confirms_plan',
                note:
                  'The user just pasted a script this turn. Present a short receipt (topic/title and roughly ' +
                  'how long the script is — never reprint the full script text, the user can already see it ' +
                  'in their own message above) plus every video setting you extracted, and ask them to ' +
                  'confirm. Do not call this tool again until the user explicitly confirms in a new message.',
              }),
            };
          }
          // A second heavy tool call in the same request is deferred, never
          // executed — its own tool_result says so, so Claude's next reply
          // (still generated below) can tell the user what happens next
          // instead of silently going quiet on this tool call.
          if (HEAVY_TOOLS.has(tool.name) && heavyToolExecuted) {
            deferredHeavyTool = tool.name;
            return {
              type: 'tool_result',
              tool_use_id: tool.id,
              content: JSON.stringify({
                deferred: true,
                note:
                  `${tool.name} will run automatically in a separate follow-up request right after this ` +
                  'one, to stay safely within the serverless function time limit. Tell the user this step ' +
                  'is continuing automatically — do not say it failed or was skipped.',
              }),
            };
          }
          if (HEAVY_TOOLS.has(tool.name)) {
            heavyToolExecuted = true;
          }
          return {
            type: 'tool_result',
            tool_use_id: tool.id,
            content: await executeTool(tool.name, jobId, tool.input),
          };
        })
      );
      messages.push({ role: 'user', content: toolResults });

      if (deferredHeavyTool) {
        // Stop here rather than asking Claude for another reply: the next
        // turn would just try the same deferred tool again, and the real
        // work should not run until the follow-up request. `messages`
        // already ends on this valid user-role tool_results turn, which is
        // exactly where the follow-up request needs to resume.
        break;
      }

      response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 16000,
        // Same top-level breakpoint as the first call above — this follow-up
        // reuses the same `messages` array (now extended with the tool_use/
        // tool_result turn) so its shared prefix reads from what the first
        // call just wrote.
        cache_control: { type: 'ephemeral' },
        system: await buildSystemPrompt(),
        tools: TOOLS,
        messages,
      });
      toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
    }

    const textBlock = response.content.find((block) => block.type === 'text');

    res.json({
      reply: textBlock ? textBlock.text : deferredHeavyTool ? 'Continuing automatically...' : '',
      conversationHistory: deferredHeavyTool ? messages : [...messages, { role: 'assistant', content: response.content }],
      jobId,
      autoContinue: Boolean(deferredHeavyTool),
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(
        'Claude API error:',
        JSON.stringify(
          {
            name: error.constructor.name,
            status: error.status,
            type: error.type,
            message: error.message,
            error: error.error,
            request_id: error.requestID,
            cause: error.cause instanceof Error ? error.cause.message : error.cause,
          },
          null,
          2
        )
      );
    } else {
      console.error(
        'Unexpected error calling Claude API:',
        JSON.stringify(
          { name: error?.name, message: error?.message, stack: error?.stack },
          null,
          2
        )
      );
    }

    res.json({
      reply: FALLBACK_REPLY,
      conversationHistory: history,
      jobId,
    });
  }
});

app.get('/api/jobs', async (req, res) => {
  res.json(await jobStore.listJobs());
});

// Lets the static frontend (frontend/app.js) populate its "Create Video"
// form controls from the same single source of truth the Agent's
// getVideoOptions tool and system prompt already use — most relevantly
// musicTrackOptions, which reflects the user-maintained data/music/
// manifest.json and can change without any frontend code change.
app.get('/api/video-options', (req, res) => {
  res.json(VIDEO_OPTIONS_DATA);
});

app.post('/api/jobs', async (req, res) => {
  const job = await jobStore.createJob();
  res.status(201).json(job);
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.patch('/api/jobs/:id', async (req, res) => {
  const job = await jobStore.updateJob(req.params.id, req.body || {});

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  res.json(job);
});

app.post('/api/jobs/:id/generate-images', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const paidVisualBlocker = findPaidVisualGenerationBlocker(job, 'scene image generation');
  if (paidVisualBlocker) {
    return res.status(400).json({ error: paidVisualBlocker });
  }

  const promptMismatch = findScenePromptMismatch(job);
  if (promptMismatch) {
    return res.status(400).json({ error: promptMismatch });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const images = await imageGeneration.generateImagesForPrompts({
      imagePrompts: job.imagePrompts,
      characters: job.characters,
      existingImages: job.images,
      outputFormat: job.outputFormat,
      jobId: job.id,
    });

    const updatedJob = await jobStore.updateJob(job.id, { images });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating images:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Image generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-voiceover', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const blocker = findVoiceoverBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const voiceover = await voiceoverGeneration.generateVoiceover({
      script: job.script,
      voiceStyle: job.voiceStyle,
      jobId: job.id,
      storyStyle: job.storyStyle,
      videoMode: job.videoMode,
      topic: job.topic,
    });

    const updates = { voiceover };
    if (voiceover.status === 'completed') {
      // See the generateVoiceover Agent tool's identical comment: a fresh
      // voice-over invalidates any already-assembled final video, any
      // already-rendered Simple Story Video section progress, and any
      // existing subtitles (transcribed from the previous narration audio).
      updates.finalVideo = {
        url: null,
        status: 'pending',
        subtitlesUsed: null,
        musicUsed: null,
        resolutionUsed: null,
        videoModeUsed: null,
        editSettingsUsed: null,
      };
      updates.simpleStoryRender = {
        status: 'not_started',
        totalSections: null,
        sections: [],
        audioUrlSnapshot: null,
        subtitlesContentSnapshot: null,
        editSettingsSnapshot: null,
        error: null,
      };
      updates.subtitles = { status: 'pending', format: 'srt', content: null, error: null, generatedFromVoiceoverUrl: null };
    }

    const updatedJob = await jobStore.updateJob(job.id, updates);
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating voice-over:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Voice-over generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-youtube-package', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const blocker = findYoutubePackageBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  try {
    const forceRegenerate = Boolean(req.body && req.body.forceRegenerate);
    const updatedJob = await runGenerateYoutubePackage(job, job.id, { forceRegenerate });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating YouTube package:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'YouTube package generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-subtitles', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const blocker = findSubtitlesBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    const forceRegenerate = Boolean(req.body && req.body.forceRegenerate);
    const updatedJob = await runGenerateSubtitles(job, job.id, { forceRegenerate });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating subtitles:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Subtitle generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/generate-video', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  const paidVisualBlocker = findPaidVisualGenerationBlocker(job, 'Runway video generation');
  if (paidVisualBlocker) {
    return res.status(400).json({ error: paidVisualBlocker });
  }

  const promptMismatch = findScenePromptMismatch(job);
  if (promptMismatch) {
    return res.status(400).json({ error: promptMismatch });
  }

  // Optional: restrict this run to exactly one scene, by its zero-based
  // index, e.g. so a single, bounded, real test can generate Scene 1 only
  // — every other scene (Scene 2 included) is guaranteed to never be
  // submitted to the provider for this call. Omitting sceneIndex generates
  // every scene, unchanged from existing behavior.
  let sceneIndex = null;
  if (req.body && req.body.sceneIndex !== undefined) {
    sceneIndex = req.body.sceneIndex;
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= job.videoPrompts.length) {
      return res.status(400).json({
        error:
          `sceneIndex must be an integer between 0 and ${job.videoPrompts.length - 1} for this job. ` +
          'No Runway request was made.',
      });
    }
  }

  // TEMPORARY safety cap (see TEMP_GENERATE_VIDEO_SCENE_CAP above) — only
  // applies to a full-job run (no sceneIndex given), since that is the only
  // case that could submit more than one paid request in a single call.
  // Refuses outright, before any provider call, rather than silently
  // truncating a larger job down to this count.
  if (sceneIndex === null && job.videoPrompts.length !== TEMP_GENERATE_VIDEO_SCENE_CAP) {
    return res.status(400).json({
      error:
        `Video generation is temporarily capped at exactly ${TEMP_GENERATE_VIDEO_SCENE_CAP} scenes ` +
        `for testing. This job has ${job.videoPrompts.length} video prompts/scenes — reduce it to ` +
        `exactly ${TEMP_GENERATE_VIDEO_SCENE_CAP}, or pass sceneIndex to generate one specific scene. ` +
        'No Runway request was made.',
      videoPromptsCount: job.videoPrompts.length,
      requiredSceneCount: TEMP_GENERATE_VIDEO_SCENE_CAP,
    });
  }

  if (!Array.isArray(job.images) || job.images.length === 0) {
    return res.status(400).json({
      error: 'job has no generated scene images yet — generate images before generating video',
    });
  }

  const activeProvider = videoGeneration.getProvider();

  if (activeProvider.name === 'runway' && !process.env.RUNWAYML_API_SECRET) {
    return res.status(500).json({ error: 'RUNWAYML_API_SECRET is not configured' });
  }

  try {
    const existingClips =
      job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

    const result = await videoGeneration.generateVideoForScenes({
      videoPrompts: job.videoPrompts,
      images: job.images,
      existingClips,
      sceneIndex,
      outputFormat: job.outputFormat,
    });

    const allCompleted = result.clips.length > 0 && result.clips.every((clip) => clip.status === 'completed');
    const anyProcessing = result.clips.some((clip) => clip.status === 'processing');
    const anyFailed = result.clips.some((clip) => clip.status === 'failed');
    // A scene left untouched by a sceneIndex-restricted run stays
    // 'not_started' — that must not be reported as an overall 'failed'
    // status, since it was never submitted at all.
    const overallStatus = allCompleted ? 'completed' : anyProcessing ? 'processing' : anyFailed ? 'failed' : 'not_started';

    const videoGenerationField = {
      provider: activeProvider.name,
      status: overallStatus,
      clips: result.clips,
      error: overallStatus === 'failed' ? 'One or more scenes failed to generate a video clip.' : null,
    };

    // finalVideo is never set here, even when every scene's clip is
    // 'completed' — that is many separate short clips, not one final
    // assembled video. POST /api/jobs/:id/assemble-video (backend/
    // video-assembly.js) is the separate, real assembly/stitching step that
    // actually produces finalVideo.
    const updatedJob = await jobStore.updateJob(job.id, { videoGeneration: videoGenerationField });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error generating video:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Video generation failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/assemble-video', async (req, res) => {
  const job = await jobStore.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  // Already assembled AND still accurate — return the existing result
  // unchanged rather than re-running ffmpeg on every call (mirrors the
  // assembleFinalVideo Agent tool's own idempotency check; see its comment
  // there and isFinalVideoStillAccurate's own comment).
  if (isFinalVideoStillAccurate(job)) {
    return res.json(job);
  }

  const blocker = findFinalVideoBlocker(job);
  if (blocker) {
    return res.status(400).json({ error: blocker });
  }

  try {
    const desiredSubtitlesContent =
      job.burnInSubtitles && job.subtitles && job.subtitles.status === 'completed' ? job.subtitles.content : null;
    const desiredMusicUsed = computeDesiredMusicUsed(job);
    const desiredResolutionUsed = computeDesiredResolutionUsed(job);
    const desiredVideoModeUsed = computeDesiredVideoModeUsed(job);
    const { finalVideo, simpleStoryRender } = await assembleAndStoreFinalVideo(
      job,
      job.id,
      desiredSubtitlesContent,
      desiredMusicUsed,
      desiredResolutionUsed,
      desiredVideoModeUsed
    );
    const updatedJob = await jobStore.updateJob(job.id, { finalVideo, simpleStoryRender });
    res.json(updatedJob);
  } catch (error) {
    console.error(
      'Unexpected error assembling final video:',
      JSON.stringify({ name: error?.name, message: error?.message }, null, 2)
    );
    res.status(502).json({ error: 'Final video assembly failed unexpectedly.' });
  }
});

app.post('/api/jobs/:id/advance', async (req, res) => {
  const result = await jobStore.advanceJob(req.params.id);

  if (result.error === 'not_found') {
    return res.status(404).json({ error: 'job not found' });
  }

  if (result.error === 'confirmation_required') {
    return res
      .status(403)
      .json({ error: 'job must be confirmed before it can be completed', job: result.job });
  }

  if (result.error === 'missing_required_output') {
    const isRenderingBlock = result.missingFields.includes('finalVideo');
    return res.status(400).json({
      error: isRenderingBlock
        ? 'Cannot mark this job COMPLETED: there is no real, single rendered final video for this ' +
          'job yet. POST /api/jobs/:id/assemble-video once every scene\'s video clip is completed. ' +
          'It stays at the READY stage until that succeeds.'
        : `Cannot advance: the current stage (${result.job.status}) is missing required output: ` +
          `${result.missingFields.join(', ')}.`,
      missingFields: result.missingFields,
      job: result.job,
    });
  }

  if (result.error === 'no_next_stage') {
    return res.status(400).json({ error: 'job has no next stage', job: result.job });
  }

  res.json(result.job);
});

// Only start a listening server when run directly (local dev / `npm start`).
// When this file is imported instead (e.g. by Vercel's Node.js serverless
// runtime), the exported `app` is invoked per-request and must not bind a
// port itself.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// executeTool is attached to the exported app (rather than changing the
// export shape to an object) purely so it can be unit-tested directly —
// app itself is still the plain Express app everywhere else (local dev,
// Vercel's serverless runtime, and existing tests that `require('./server')`
// expecting the listenable app).
module.exports = app;
module.exports.executeTool = executeTool;
module.exports.buildCachedSystemPrompt = buildCachedSystemPrompt;
module.exports.SYSTEM_PROMPT_BASE = SYSTEM_PROMPT_BASE;
module.exports.TOOLS = TOOLS;
module.exports.isScriptPasteRequest = isScriptPasteRequest;
module.exports.PAID_OR_CONFIRM_TOOLS = PAID_OR_CONFIRM_TOOLS;
