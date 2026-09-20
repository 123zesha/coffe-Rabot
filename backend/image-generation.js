// Generates real scene images through the OpenAI Images API for the
// ASSET GENERATION stage. This module is deliberately independent of the
// Anthropic tool-use loop in server.js — it is only ever invoked through
// its own REST route, so the conversational agent, its tools, and the
// stage/confirmation gates in server.js and job-store.js are untouched.

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');
const { OUTPUT_FORMATS, DEFAULT_OUTPUT_FORMAT } = require('./job-store');
const videoStorage = require('./video-storage');

// gpt-image-2 is OpenAI's current general-purpose image model (verified
// against the OpenAI API docs/SDK type definitions at integration time).
// OpenAI's image API does not offer an exact 16:9 preset — the supported
// sizes are 1024x1024, 1536x1024, and 1024x1536. 1536x1024 (3:2) is the
// widest landscape size available and the closest match to a 16:9
// widescreen composition; 1024x1536 (2:3) is the matching portrait size,
// used for job.outputFormat 'vertical' (9:16 Shorts); 1024x1024 is used
// for 'square' (1:1). These three sizes are the ONLY ones OpenAI's image
// API offers, so they are also the only three job.outputFormat values
// this app supports (see job-store.js's OUTPUT_FORMATS).
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_SIZE = '1536x1024';
const IMAGE_SIZE_BY_FORMAT = {
  horizontal: '1536x1024',
  vertical: '1024x1536',
  square: '1024x1024',
};

function resolveImageSize(outputFormat) {
  return IMAGE_SIZE_BY_FORMAT[outputFormat] || IMAGE_SIZE_BY_FORMAT[DEFAULT_OUTPUT_FORMAT];
}
// 'medium', not 'high': at 'high' quality, a single gpt-image-2 generation
// can take from tens of seconds up to ~3-4 minutes. generateImagesForPrompts
// runs one real, synchronous OpenAI call per prompt in sequence, and — since
// the generateSceneImages Agent tool invokes this same function inside the
// single request/response cycle of POST /api/agent — that easily exceeds a
// serverless function's execution time limit for a job with more than one
// scene. A platform-level timeout kills the request before this module's
// own error handling ever runs, which is what made this failure mode look
// like a silent, unexplained "image generation unavailable" rather than a
// clear error. 'medium' cuts real generation latency substantially while
// keeping quality suitable for scene stills; this is a real reduction in
// the actual work being done, not a cosmetic change.
const IMAGE_QUALITY = 'medium';

let cachedClient = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set.');
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return cachedClient;
}

// Turns the job's existing character descriptions into a short instruction
// block so every generated scene is prompted with the same character
// details, keeping their described appearance consistent scene to scene.
function buildCharacterContext(characters) {
  if (!Array.isArray(characters) || characters.length === 0) {
    return '';
  }

  const descriptions = characters
    .map((character) => (typeof character === 'string' ? character : JSON.stringify(character)))
    .map((description) => description.trim())
    .filter((description) => description.length > 0);

  if (descriptions.length === 0) {
    return '';
  }

  return 'These characters must look the same in every scene: ' + descriptions.join('; ') + '.';
}

// The composition described to the model must actually match the frame
// shape it's being asked to fill — sizing a request correctly but still
// prompting it as "widescreen" would reliably produce a badly-composed
// portrait/square image (e.g. a wide scene awkwardly cropped), not just a
// technically-wrong-shaped one. Each directive keeps the same cinematic/
// lighting language, only the framing description changes.
const FRAME_DIRECTIVE_BY_FORMAT = {
  horizontal: 'widescreen composition',
  vertical: 'vertical portrait composition, subject centered and framed for a tall 9:16 frame',
  square: 'square 1:1 composition, subject centered',
};

function buildPrompt(scenePrompt, characterContext, outputFormat) {
  const frameDirective = FRAME_DIRECTIVE_BY_FORMAT[outputFormat] || FRAME_DIRECTIVE_BY_FORMAT[DEFAULT_OUTPUT_FORMAT];
  const styleDirective = `Cinematic, photorealistic film still, dramatic lighting, ${frameDirective}.`;

  return [styleDirective, characterContext, `Scene: ${scenePrompt}`]
    .filter((part) => part && part.trim().length > 0)
    .join('\n');
}

// Reads a generated image's real bytes back from its stored url — every
// shape video-storage.js's storeImageFile can produce: a real https:// URL
// (Vercel Blob in production), a /generated/... local reference (the
// no-Blob-token dev/test fallback, read straight from disk), or a legacy
// base64 data: URI (kept for backward compatibility with images generated
// before storage moved out of the job record). Returns null for anything
// else, or for a reference that decodes/downloads to zero bytes.
async function resolveImageBuffer(url) {
  if (typeof url !== 'string' || !url) {
    return null;
  }

  let buffer;
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (!match) {
      return null;
    }
    buffer = Buffer.from(match[2], 'base64');
  } else if (url.startsWith('/generated/')) {
    const filePath = path.join(videoStorage.GENERATED_DIR, url.slice('/generated/'.length));
    if (!fs.existsSync(filePath)) {
      return null;
    }
    buffer = fs.readFileSync(filePath);
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    return null;
  }

  return buffer.length > 0 ? buffer : null;
}

// Finds the most recent successfully generated image in the job so it can
// be passed back into the API as a reference for the next scene, biasing
// the model toward keeping the same character appearance across scenes.
async function findReferenceImageBuffer(existingImages) {
  if (!Array.isArray(existingImages)) {
    return null;
  }

  const reference = [...existingImages].reverse().find((image) => image && image.status === 'completed' && image.url);

  return reference ? resolveImageBuffer(reference.url) : null;
}

function describeError(error) {
  if (error instanceof OpenAI.APIError) {
    return `${error.status || ''} ${error.message}`.trim();
  }
  return (error && error.message) || 'Unknown error generating image.';
}

async function generateSceneImage({ prompt, characterContext, referenceImageBuffer, outputFormat, jobId }) {
  const client = getClient();
  const fullPrompt = buildPrompt(prompt, characterContext, outputFormat);
  const size = resolveImageSize(outputFormat);

  let response;
  if (referenceImageBuffer) {
    const referenceFile = await toFile(referenceImageBuffer, 'reference.png', { type: 'image/png' });
    // A single reference image must be passed as-is, not wrapped in an
    // array. The SDK's TypeScript types accept image: Uploadable[], but the
    // real OpenAI API rejects an array with "400 Invalid type for 'image':
    // expected a file, but got an array instead" (a documented mismatch
    // between the SDK types and actual API behavior). Since every scene
    // after the first always takes this branch (it references the
    // previous scene's image for character consistency), the array form
    // deterministically broke image generation for any job with more than
    // one scene.
    response = await client.images.edit({
      model: IMAGE_MODEL,
      image: referenceFile,
      prompt: fullPrompt,
      size,
      quality: IMAGE_QUALITY,
    });
  } else {
    response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: fullPrompt,
      size,
      quality: IMAGE_QUALITY,
    });
  }

  const imageResult = response && Array.isArray(response.data) ? response.data[0] : null;
  const base64 = imageResult && imageResult.b64_json;

  if (!base64) {
    throw new Error('OpenAI did not return image data.');
  }

  const buffer = Buffer.from(base64, 'base64');
  const url = await videoStorage.storeImageFile(buffer, jobId);

  return { url, buffer };
}

// Generates one image per entry in `imagePrompts`, reusing any already-
// completed result for the same prompt text instead of regenerating it.
// A prompt is only ever marked 'completed' when the API actually returned
// image data; any failure is recorded as 'failed' with an error message,
// never a fabricated URL.
async function generateImagesForPrompts({ imagePrompts, characters, existingImages, outputFormat, jobId }) {
  const resolvedFormat = OUTPUT_FORMATS.includes(outputFormat) ? outputFormat : DEFAULT_OUTPUT_FORMAT;
  const size = resolveImageSize(resolvedFormat);

  // Diagnostic logging so a real production failure (or a request that
  // never finishes at all, e.g. a serverless timeout) is visible in server
  // logs instead of silently looking like "image generation unavailable"
  // with no further information. Never logs anything from the API
  // key/request headers — only prompt counts and per-image status/error
  // text already produced below.
  console.log(
    `Starting image generation for ${imagePrompts.length} prompt(s) ` +
      `(model=${IMAGE_MODEL}, size=${size}, quality=${IMAGE_QUALITY}, format=${resolvedFormat}).`
  );

  const characterContext = buildCharacterContext(characters);
  const images = [];
  let referenceImageBuffer = await findReferenceImageBuffer(existingImages);

  for (const prompt of imagePrompts) {
    // Only reuse an already-completed image for this exact prompt if it was
    // ALSO generated at the currently-desired outputFormat — a job whose
    // outputFormat changed after this scene already completed must
    // regenerate it for real, never silently keep a wrong-shaped image just
    // to save a call (a missing/legacy outputFormat on an old image record
    // is treated as 'horizontal', its true original default).
    const existing = Array.isArray(existingImages)
      ? existingImages.find(
          (image) =>
            image &&
            image.prompt === prompt &&
            image.status === 'completed' &&
            (image.outputFormat || DEFAULT_OUTPUT_FORMAT) === resolvedFormat
        )
      : null;

    if (existing) {
      images.push(existing);
      continue;
    }

    try {
      const result = await generateSceneImage({ prompt, characterContext, referenceImageBuffer, outputFormat: resolvedFormat, jobId });
      images.push({ prompt, url: result.url, status: 'completed', outputFormat: resolvedFormat });
      referenceImageBuffer = result.buffer;
    } catch (error) {
      console.error(
        'OpenAI image generation error:',
        JSON.stringify({ prompt, message: describeError(error) }, null, 2)
      );
      images.push({ prompt, url: null, status: 'failed', error: describeError(error) });
    }
  }

  const completedCount = images.filter((image) => image.status === 'completed').length;
  const failedCount = images.filter((image) => image.status === 'failed').length;
  console.log(
    `Finished image generation: ${completedCount} completed, ${failedCount} failed, ` +
      `${images.length} total.`
  );

  return images;
}

// Generates a single, original thumbnail image for the optional "YouTube
// Publishing Package" feature (see backend/youtube-package.js for the text
// half of that package). Reuses this same OpenAI image backend/model/size —
// no new paid provider — via the same generateSceneImage used for scene
// stills, just with no character-consistency reference image (a thumbnail
// is a standalone composition, not part of the scene sequence). Never given
// any reference-video content — see youtube-package.js's own comment for
// why. Returns { url, status, error? }, the same shape as one entry of
// generateImagesForPrompts, and never fabricates a url on failure.
async function generateThumbnailImage({ thumbnailConcept, thumbnailText, jobId }) {
  const promptParts = [
    'Cinematic, eye-catching YouTube thumbnail image, bold composition, widescreen (16:9) framing, ' +
      'high contrast, vibrant colors.',
    `Concept: ${thumbnailConcept}`,
  ];
  if (thumbnailText) {
    promptParts.push(
      `If including text, render exactly this short text prominently and legibly: "${thumbnailText}"`
    );
  }
  const prompt = promptParts.join('\n');

  try {
    const result = await generateSceneImage({ prompt, characterContext: '', referenceImageBuffer: null, jobId });
    return { url: result.url, status: 'completed', error: null };
  } catch (error) {
    console.error(
      'OpenAI thumbnail image generation error:',
      JSON.stringify({ message: describeError(error) }, null, 2)
    );
    return { url: null, status: 'failed', error: describeError(error) };
  }
}

module.exports = {
  generateImagesForPrompts,
  generateThumbnailImage,
  IMAGE_MODEL,
  IMAGE_SIZE,
  IMAGE_SIZE_BY_FORMAT,
  IMAGE_QUALITY,
};
