const jobs = new Map();
let nextId = 1;

const JOB_FIELDS = [
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
  'voiceover',
  'subtitles',
  'music',
  'thumbnail',
  'description',
  'status',
  'confirmed',
];

function createDefaultJob() {
  return {
    topic: '',
    videoTitle: '',
    duration: '',
    language: '',
    storyStyle: '',
    script: '',
    scenes: [],
    characters: [],
    imagePrompts: [],
    videoPrompts: [],
    voiceover: '',
    subtitles: '',
    music: '',
    thumbnail: '',
    description: '',
    status: 'draft',
    confirmed: false,
  };
}

function createJob() {
  const id = String(nextId++);
  const job = { id, ...createDefaultJob() };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }

  for (const field of JOB_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      job[field] = updates[field];
    }
  }

  return job;
}

module.exports = { JOB_FIELDS, createJob, getJob, updateJob };
