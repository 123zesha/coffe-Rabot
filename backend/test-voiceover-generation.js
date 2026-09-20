// Tests for backend/voiceover-generation.js's ADAPTIVE VOICE-OVER SYSTEM —
// resolveVoiceDirection (pure, no API calls) and its wiring into
// generateVoiceover's real OpenAI TTS request. Covers: mood/style
// detection from storyStyle/topic text, the videoMode 'simple-story'
// (English-learning) clarity override, the universal natural-delivery
// guardrail, and that the SAME instructions/speed reach every chunk of a
// multi-chunk script (one consistent narrator throughout, never a separate
// style per chunk).
//
// Uses a local mock OpenAI TTS server (no real OpenAI API calls, no cost).
// Run with:
//   node test-voiceover-generation.js
// or:
//   npm run test:voiceover-generation

const http = require('http');
const assert = require('assert');

const { generateVoiceover, resolveVoiceDirection } = require('./voiceover-generation');

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

const REAL_SCRIPT =
  'Welcome to this video about the quiet lighthouse at the edge of town. ' +
  'For a hundred years it has guided ships safely home through fog and storm. ' +
  'Tonight, we look at the people who kept its light burning, generation after generation.';

let requestBodies = [];

function startMockOpenAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          requestBodies.push(null);
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.from('fake mp3 audio bytes'));
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  // --- resolveVoiceDirection: pure function, no API calls at all ---

  await test('resolveVoiceDirection falls back to a warm, natural default when storyStyle/topic give no signal', () => {
    const result = resolveVoiceDirection({ storyStyle: '', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('warm'));
    assert.strictEqual(result.speed, 1);
  });

  await test('resolveVoiceDirection detects a sad/emotional story and slows down, softens', () => {
    const result = resolveVoiceDirection({ storyStyle: 'A sad story about loss', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('soft'));
    assert.ok(result.speed < 1, 'a sad story must speak slower than the neutral default');
  });

  await test('resolveVoiceDirection detects a happy/joyful story and brightens, energizes slightly', () => {
    const result = resolveVoiceDirection({ storyStyle: 'A happy, cheerful tale', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('bright'));
    assert.ok(result.speed > 1, 'a happy story must speak slightly faster than the neutral default');
  });

  await test('resolveVoiceDirection detects suspense and asks for controlled tension, meaningful pauses', () => {
    const result = resolveVoiceDirection({ storyStyle: 'A suspenseful thriller', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('tension'));
    assert.ok(result.instructions.toLowerCase().includes('pause'));
  });

  await test('resolveVoiceDirection detects a motivational video and sounds confident and energetic', () => {
    const result = resolveVoiceDirection({ storyStyle: 'A motivational speech', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('confident'));
    assert.ok(result.speed > 1, 'a motivational video must speak slightly faster/more energetically');
  });

  await test('resolveVoiceDirection detects a documentary/informational style and stays calm and authoritative', () => {
    const result = resolveVoiceDirection({ storyStyle: 'documentary', videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('calm'));
    assert.ok(result.instructions.toLowerCase().includes('authoritative'));
  });

  await test('resolveVoiceDirection detects a children\'s story and sounds friendly and gently expressive', () => {
    const result = resolveVoiceDirection({ storyStyle: "A children's bedtime story", videoMode: 'cinematic', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('friendly'));
  });

  await test('resolveVoiceDirection also reads the topic when storyStyle gives no signal', () => {
    const result = resolveVoiceDirection({ storyStyle: '', videoMode: 'cinematic', topic: 'A tragic, heartbreaking loss' });
    assert.ok(result.speed < 1, 'topic-derived sad mood must still slow the pace down');
  });

  await test('resolveVoiceDirection: videoMode simple-story (English-learning) always adds a clarity/pace directive', () => {
    const result = resolveVoiceDirection({ storyStyle: '', videoMode: 'simple-story', topic: '' });
    assert.ok(result.instructions.toLowerCase().includes('pronunciation'));
    assert.ok(result.instructions.toLowerCase().includes('english-learning') || result.instructions.toLowerCase().includes('listening-practice'));
    assert.ok(result.speed <= 0.92, 'English-learning mode must cap the pace at a comfortable, slower speed');
  });

  await test('resolveVoiceDirection: simple-story caps speed even for an energetic mood (clarity wins)', () => {
    const result = resolveVoiceDirection({ storyStyle: 'A motivational speech', videoMode: 'simple-story', topic: '' });
    assert.ok(result.speed <= 0.92, 'simple-story must never speed up past the learner-comfortable ceiling');
  });

  await test('resolveVoiceDirection always includes the natural, non-robotic delivery guardrail', () => {
    for (const storyStyle of ['', 'sad', 'happy', 'suspense', 'motivational', 'documentary', "children's story"]) {
      const result = resolveVoiceDirection({ storyStyle, videoMode: 'cinematic', topic: '' });
      assert.ok(result.instructions.toLowerCase().includes('never robotic'), `missing guardrail for storyStyle="${storyStyle}"`);
    }
  });

  await test('resolveVoiceDirection speed always stays within OpenAI\'s documented 0.25-4.0 range', () => {
    const storyStyles = ['', 'sad', 'happy', 'suspense', 'motivational', 'documentary', "children's story", 'vlog'];
    for (const storyStyle of storyStyles) {
      for (const videoMode of ['cinematic', 'simple-story']) {
        const result = resolveVoiceDirection({ storyStyle, videoMode, topic: '' });
        assert.ok(result.speed >= 0.25 && result.speed <= 4.0, `speed out of range for storyStyle="${storyStyle}" videoMode="${videoMode}"`);
      }
    }
  });

  // --- Wiring into the real generateVoiceover TTS request (mocked OpenAI) ---

  const mockOpenAiServer = await startMockOpenAi();
  const openAiPort = mockOpenAiServer.address().port;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://localhost:${openAiPort}/v1`;

  await test('generateVoiceover sends the resolved instructions/speed to the real OpenAI TTS call', async () => {
    requestBodies = [];
    const result = await generateVoiceover({
      script: REAL_SCRIPT,
      voiceStyle: 'female-warm',
      jobId: 'job-adaptive-1',
      storyStyle: 'A sad, heartbreaking story',
      videoMode: 'cinematic',
      topic: '',
    });

    assert.strictEqual(result.status, 'completed', JSON.stringify(result));
    assert.strictEqual(requestBodies.length, 1, 'a short script is one chunk, one real TTS call');
    assert.ok(requestBodies[0].instructions.toLowerCase().includes('soft'));
    assert.ok(requestBodies[0].speed < 1);
    // The narrator identity (voice) is unaffected by adaptive mood.
    assert.strictEqual(requestBodies[0].voice, 'shimmer');
  });

  await test('generateVoiceover sends the SAME instructions/speed to every chunk of a multi-chunk script (one consistent narrator)', async () => {
    const LONG_SCRIPT = Array(55).fill(REAL_SCRIPT).join(' '); // ~12,800 characters, multiple chunks
    requestBodies = [];
    const result = await generateVoiceover({
      script: LONG_SCRIPT,
      voiceStyle: 'neutral-narrator',
      jobId: 'job-adaptive-2',
      storyStyle: 'A motivational story',
      videoMode: 'cinematic',
      topic: '',
    });

    assert.strictEqual(result.status, 'completed', JSON.stringify(result));
    assert.ok(requestBodies.length >= 3, `expected multiple TTS chunks, got ${requestBodies.length}`);

    const distinctInstructions = new Set(requestBodies.map((body) => body.instructions));
    const distinctSpeeds = new Set(requestBodies.map((body) => body.speed));
    assert.strictEqual(distinctInstructions.size, 1, 'every chunk must receive identical instructions — one narrator style throughout');
    assert.strictEqual(distinctSpeeds.size, 1, 'every chunk must receive the identical speed');
    assert.ok([...distinctInstructions][0].toLowerCase().includes('confident'));
  });

  await test('generateVoiceover: a simple-story (English-learning) job gets the clarity-first direction on the real call', async () => {
    requestBodies = [];
    const result = await generateVoiceover({
      script: REAL_SCRIPT,
      voiceStyle: 'neutral-narrator',
      jobId: 'job-adaptive-3',
      storyStyle: '',
      videoMode: 'simple-story',
      topic: '',
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(requestBodies[0].instructions.toLowerCase().includes('pronunciation'));
    assert.ok(requestBodies[0].speed <= 0.92);
  });

  mockOpenAiServer.close();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll voiceover-generation adaptive voice-direction tests passed.');
  }
}

main();
