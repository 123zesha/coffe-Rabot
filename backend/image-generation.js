// Generates real scene images through the OpenAI Images API for the
// ASSET GENERATION stage. This module is deliberately independent of the
// Anthropic tool-use loop in server.js — it is only ever invoked through
// its own REST route, so the conversational agent, its tools, and the
// stage/confirmation gates in server.js and job-store.js are untouched.

const OpenAI = require('openai');
const { toFile } = require('openai');

// gpt-image-2 is OpenAI's current general-purpose image model (verified
// against the OpenAI API docs/SDK type definitions at integration time).
// OpenAI's image API does not offer an exact 16:9 preset — the supported
// sizes are 1024x1024, 1536x1024, and 1024x1536. 1536x1024 (3:2) is the
// widest landscape size available and the closest match to a 16:9
// widescreen composition.
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_SIZE = '1536x1024';
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

function buildPrompt(scenePrompt, characterContext) {
  const styleDirective =
    'Cinematic, photorealistic film still, dramatic lighting, widescreen composition.';

  return [styleDirective, characterContext, `Scene: ${scenePrompt}`]
    .filter((part) => part && part.trim().length > 0)
    .join('\n');
}

// Finds the most recent successfully generated image in the job so it can
// be passed back into the API as a reference for the next scene, biasing
// the model toward keeping the same character appearance across scenes.
function findReferenceDataUri(existingImages) {
  if (!Array.isArray(existingImages)) {
    return null;
  }

  const reference = [...existingImages]
    .reverse()
    .find((image) => image && image.status === 'completed' && typeof image.url === 'string' && image.url.startsWith('data:'));

  return reference ? reference.url : null;
}

async function dataUriToFile(dataUri) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUri);
  if (!match) {
    return null;
  }

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  const extension = mimeType.split('/')[1] || 'png';

  return toFile(buffer, `reference.${extension}`, { type: mimeType });
}

function describeError(error) {
  if (error instanceof OpenAI.APIError) {
    return `${error.status || ''} ${error.message}`.trim();
  }
  return (error && error.message) || 'Unknown error generating image.';
}

async function generateSceneImage({ prompt, characterContext, referenceDataUri }) {
  const client = getClient();
  const fullPrompt = buildPrompt(prompt, characterContext);

  let response;
  if (referenceDataUri) {
    const referenceFile = await dataUriToFile(referenceDataUri);
    response = await client.images.edit({
      model: IMAGE_MODEL,
      image: [referenceFile],
      prompt: fullPrompt,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
    });
  } else {
    response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: fullPrompt,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
    });
  }

  const imageResult = response && Array.isArray(response.data) ? response.data[0] : null;
  const base64 = imageResult && imageResult.b64_json;

  if (!base64) {
    throw new Error('OpenAI did not return image data.');
  }

  return `data:image/png;base64,${base64}`;
}

// Generates one image per entry in `imagePrompts`, reusing any already-
// completed result for the same prompt text instead of regenerating it.
// A prompt is only ever marked 'completed' when the API actually returned
// image data; any failure is recorded as 'failed' with an error message,
// never a fabricated URL.
async function generateImagesForPrompts({ imagePrompts, characters, existingImages }) {
  // Diagnostic logging so a real production failure (or a request that
  // never finishes at all, e.g. a serverless timeout) is visible in server
  // logs instead of silently looking like "image generation unavailable"
  // with no further information. Never logs anything from the API
  // key/request headers — only prompt counts and per-image status/error
  // text already produced below.
  console.log(
    `Starting image generation for ${imagePrompts.length} prompt(s) ` +
      `(model=${IMAGE_MODEL}, size=${IMAGE_SIZE}, quality=${IMAGE_QUALITY}).`
  );

  const characterContext = buildCharacterContext(characters);
  const images = [];
  let referenceDataUri = findReferenceDataUri(existingImages);

  for (const prompt of imagePrompts) {
    const existing = Array.isArray(existingImages)
      ? existingImages.find((image) => image && image.prompt === prompt && image.status === 'completed')
      : null;

    if (existing) {
      images.push(existing);
      continue;
    }

    try {
      const url = await generateSceneImage({ prompt, characterContext, referenceDataUri });
      images.push({ prompt, url, status: 'completed' });
      referenceDataUri = url;
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

module.exports = { generateImagesForPrompts, IMAGE_MODEL, IMAGE_SIZE, IMAGE_QUALITY };
