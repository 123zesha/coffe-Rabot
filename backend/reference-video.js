// "Reference Video / Inspiration Mode": lets the user point at a YouTube
// video and have the Agent use only its general STORYTELLING FORMAT as
// inspiration for a brand-new, original script — never its transcript,
// dialogue, character names/designs, exact scenes, title, thumbnail, or
// music. This module only ever produces that high-level analysis; nothing
// here writes job.script — the conversational agent does that afterward,
// the same way it always has (see prompts/system-prompt.md).
//
// This is deliberately independent of the Anthropic tool-use loop in
// server.js — it makes its own, separate Claude API call, exactly like
// image-generation.js/voiceover-generation.js each make their own
// independent OpenAI calls — so the main conversation's tool wiring, and
// the stage/confirmation gates in job-store.js, are untouched.
//
// No new paid service is added: getting *some* real signal about the video
// uses two free, keyless, public YouTube endpoints (oEmbed for title/
// channel, and a best-effort scrape of the watch page's own caption-track
// data when captions exist) — never the YouTube Data API, never a
// third-party transcript service. The one real API call this module makes
// is to Claude, reusing the exact same Anthropic integration (API key,
// model) already central to the whole app — not a new service, just an
// additional call within the one already in use.
//
// A bare video URL alone is often NOT enough to honestly answer several of
// the requested elements (pacing, scene count, dialogue style) — oEmbed
// gives only a title/channel, and many videos have no usable captions at
// all. referenceVideoNotes (a synopsis/description/transcript excerpt the
// user pastes in themselves) exists specifically so the analysis has real
// material to work from even when the automatic caption scrape comes up
// empty; the prompt below is explicit that the model must say so rather
// than invent detail when the available information is thin.

const Anthropic = require('@anthropic-ai/sdk');

const OEMBED_BASE_URL = process.env.YOUTUBE_OEMBED_BASE_URL || 'https://www.youtube.com/oembed';
const WATCH_PAGE_BASE_URL = process.env.YOUTUBE_WATCH_BASE_URL || 'https://www.youtube.com/watch';
const ANALYSIS_MODEL = 'claude-opus-5';
// Generous enough for a real video's auto-captions to convey pacing/
// structure, small enough to keep this one-off analysis call cheap and
// fast — this is a format inspiration aid, not a transcription service.
const MAX_TRANSCRIPT_CHARS = 6000;

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

// Recognizes youtube.com/watch?v=, youtu.be/<id>, youtube.com/shorts/<id>,
// youtube.com/embed/<id>, and youtube.com/live/<id> (with or without extra
// query params). Returns null for anything else — including non-YouTube
// URLs and malformed input — so callers refuse cleanly before making any
// call at all, never guessing at a video from an unrecognized link.
function extractYouTubeVideoId(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (error) {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const idPattern = /^[\w-]{11}$/;

  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return idPattern.test(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') {
      const id = parsed.searchParams.get('v');
      return id && idPattern.test(id) ? id : null;
    }
    const match = parsed.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    return match ? match[2] : null;
  }

  return null;
}

// Free, keyless, standard YouTube endpoint — gives only a title and
// channel name, never a description or duration. Returns null on any
// failure (private/deleted/age-restricted video, network error, etc.);
// never throws, since this is best-effort context, not a required input.
async function fetchOEmbedMetadata(videoId, fetchImpl = fetch) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetchImpl(`${OEMBED_BASE_URL}?format=json&url=${encodeURIComponent(watchUrl)}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return {
      title: typeof data.title === 'string' ? data.title : null,
      authorName: typeof data.author_name === 'string' ? data.author_name : null,
    };
  } catch (error) {
    return null;
  }
}

// Best-effort only: scrapes the watch page for its own embedded caption-
// track list (the same data the YouTube player itself uses) and fetches
// the first available track. No API key, no third-party service — but
// also no guarantee: many videos have no captions, and this depends on
// YouTube's page markup staying roughly as it is today. Any failure at any
// step (no captions, page fetch fails, unexpected markup, empty track)
// returns null — callers always fall back to metadata/notes alone, never
// block or error out because this didn't work.
async function fetchTranscriptBestEffort(videoId, fetchImpl = fetch) {
  try {
    const pageResponse = await fetchImpl(`${WATCH_PAGE_BASE_URL}?v=${encodeURIComponent(videoId)}`);
    if (!pageResponse.ok) {
      return null;
    }
    const html = await pageResponse.text();

    const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!tracksMatch) {
      return null;
    }

    let tracks;
    try {
      tracks = JSON.parse(tracksMatch[1].replace(/\\u0026/g, '&'));
    } catch (error) {
      return null;
    }
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return null;
    }

    const track = tracks.find((t) => t && t.languageCode === 'en') || tracks[0];
    if (!track || typeof track.baseUrl !== 'string') {
      return null;
    }

    const captionResponse = await fetchImpl(track.baseUrl);
    if (!captionResponse.ok) {
      return null;
    }
    const xml = await captionResponse.text();

    const text = xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    return text.length > 0 ? text.slice(0, MAX_TRANSCRIPT_CHARS) : null;
  } catch (error) {
    return null;
  }
}

// Produces { status: 'completed', summary, error: null } or
// { status: 'failed', summary: null, error }. Never fabricates a summary:
// if extraction of a valid video ID fails, or if no real information (no
// metadata, no transcript, no user notes) could be gathered at all, this
// fails honestly instead of asking Claude to invent detail. The prompt
// itself also explicitly forbids inventing an answer for any one element
// the available information doesn't actually support.
async function analyzeReferenceVideo({ referenceVideoUrl, referenceVideoNotes }, { fetchImpl = fetch } = {}) {
  const videoId = extractYouTubeVideoId(referenceVideoUrl);
  if (!videoId) {
    return {
      status: 'failed',
      summary: null,
      error:
        'referenceVideoUrl is not a recognizable YouTube video URL (expected a youtube.com/watch, ' +
        'youtu.be, youtube.com/shorts, or youtube.com/embed link).',
    };
  }

  const metadata = await fetchOEmbedMetadata(videoId, fetchImpl);
  const transcript = await fetchTranscriptBestEffort(videoId, fetchImpl);
  const notes = typeof referenceVideoNotes === 'string' ? referenceVideoNotes.trim() : '';

  if (!metadata && !transcript && !notes) {
    return {
      status: 'failed',
      summary: null,
      error:
        'Could not retrieve any real information about this video (no public title, no usable captions, ' +
        'and no reference notes were provided) — add a short synopsis to the reference notes and try again.',
    };
  }

  const sourceLines = [];
  if (metadata && metadata.title) {
    sourceLines.push(`Video title: ${metadata.title}`);
  }
  if (metadata && metadata.authorName) {
    sourceLines.push(`Channel: ${metadata.authorName}`);
  }
  if (notes) {
    sourceLines.push(`User-provided notes/synopsis:\n${notes}`);
  }
  if (transcript) {
    sourceLines.push(`Auto-generated caption text (may be imperfect, possibly partial):\n${transcript}`);
  }

  const prompt =
    'You are analyzing a YouTube video ONLY to extract its general storytelling FORMAT, as inspiration ' +
    'for writing a completely new, original video. You are not summarizing its plot for reproduction, ' +
    'and nothing you write here will ever be shown to end users verbatim — it is internal creative ' +
    '-direction notes for a scriptwriter.\n\n' +
    'Using only the information given below, describe these high-level elements — and ONLY these:\n' +
    '- story type/theme (in general terms)\n' +
    '- pacing\n' +
    '- approximate duration\n' +
    '- approximate number and length of scenes\n' +
    '- dialogue vs. narration style\n' +
    '- visual/camera style\n' +
    '- emotional tone\n' +
    '- moral/lesson structure, if any\n\n' +
    'Strict rules:\n' +
    '- Never quote or closely paraphrase exact dialogue or narration.\n' +
    '- Never name or describe any specific character by name or exact appearance.\n' +
    '- Never describe the exact sequence of scenes/events — only the general STRUCTURE (e.g. "opens with ' +
    'a problem, three escalating attempts, a twist, then a resolution").\n' +
    "- Never mention the video's own title, thumbnail, or music.\n" +
    "- If the available information doesn't support a confident answer for one of the elements above, " +
    'say so plainly instead of guessing or inventing detail.\n\n' +
    'Available information:\n' +
    sourceLines.join('\n\n');

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = Array.isArray(response.content) ? response.content.find((block) => block.type === 'text') : null;

    if (!textBlock || !textBlock.text || !textBlock.text.trim()) {
      return { status: 'failed', summary: null, error: 'The analysis call did not return any text.' };
    }

    return { status: 'completed', summary: textBlock.text.trim(), error: null };
  } catch (error) {
    return {
      status: 'failed',
      summary: null,
      error: (error && error.message) || 'Unknown error analyzing the reference video.',
    };
  }
}

module.exports = {
  extractYouTubeVideoId,
  fetchOEmbedMetadata,
  fetchTranscriptBestEffort,
  analyzeReferenceVideo,
  MAX_TRANSCRIPT_CHARS,
};
