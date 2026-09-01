const tableBody = document.getElementById('jobs-table-body');
const newJobBtn = document.getElementById('new-job-btn');
const messageEl = document.getElementById('dashboard-message');
const newJobForm = document.getElementById('new-job-form');
const newJobCancelBtn = document.getElementById('new-job-cancel');
const newJobTopicInput = document.getElementById('new-job-topic');
const newJobDurationInput = document.getElementById('new-job-duration');
const newJobLanguageInput = document.getElementById('new-job-language');
const newJobStyleInput = document.getElementById('new-job-style');

let lastJobs = [];
const generatingImageJobIds = new Set();
const imageGenerationRequestErrors = new Map();
const generatingVoiceoverJobIds = new Set();
const voiceoverGenerationRequestErrors = new Map();

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'dashboard-message ' + (type || '');
  messageEl.hidden = false;
}

function clearMessage() {
  messageEl.hidden = true;
  messageEl.textContent = '';
}

function confirmationLabel(job) {
  return job.confirmed ? 'Confirmed' : 'Not Confirmed';
}

function generateImagesButtonLabel(job, isGenerating, hasPrompts) {
  if (isGenerating) return 'Generating…';
  if (!hasPrompts) return 'No Image Prompts Yet';
  const images = Array.isArray(job.images) ? job.images : [];
  if (images.length === 0) return 'Generate Images';
  return images.some((image) => image.status === 'failed') ? 'Retry Images' : 'Regenerate Images';
}

function renderGenerationRow(job) {
  const isGenerating = generatingImageJobIds.has(job.id);
  const requestError = imageGenerationRequestErrors.get(job.id);
  const images = Array.isArray(job.images) ? job.images : [];

  if (!isGenerating && !requestError && images.length === 0) {
    return '';
  }

  let statusLabel = 'Ready';
  let statusClass = 'ready';

  if (isGenerating) {
    statusLabel = 'Generating';
    statusClass = 'generating';
  } else if (requestError) {
    statusLabel = 'Failed';
    statusClass = 'failed';
  } else if (images.length > 0) {
    const completedCount = images.filter((image) => image.status === 'completed').length;
    const failedCount = images.filter((image) => image.status === 'failed').length;
    if (failedCount === 0) {
      statusLabel = 'Completed';
      statusClass = 'completed';
    } else if (completedCount === 0) {
      statusLabel = 'Failed';
      statusClass = 'failed';
    } else {
      statusLabel = 'Partial Failure';
      statusClass = 'partial';
    }
  }

  const tiles = isGenerating
    ? '<p class="generated-images-hint">Generating scene images…</p>'
    : images
        .map((image) => {
          if (image.status === 'completed' && image.url) {
            return `<figure class="generated-image-tile"><img src="${image.url}" alt="Generated scene image" loading="lazy"><figcaption>${image.prompt}</figcaption></figure>`;
          }
          return `<div class="generated-image-tile generated-image-tile-error"><p class="generated-image-error">Failed: ${image.error || 'Unknown error'}</p><figcaption>${image.prompt}</figcaption></div>`;
        })
        .join('');

  const requestErrorHtml = requestError
    ? `<p class="generated-images-error">${requestError}</p>`
    : '';

  return `
    <tr class="generated-images-row">
      <td colspan="8">
        <div class="generated-images-panel">
          <span class="generation-badge ${statusClass}">${statusLabel}</span>
          ${requestErrorHtml}
          <div class="generated-images-grid">${tiles}</div>
        </div>
      </td>
    </tr>
  `;
}

function generateVoiceoverButtonLabel(job, isGenerating) {
  if (isGenerating) return 'Generating…';
  const voiceover = job.voiceover;
  if (voiceover && typeof voiceover === 'object' && voiceover.status === 'completed') return 'Regenerate Voice-over';
  if (voiceover && typeof voiceover === 'object' && voiceover.status === 'failed') return 'Retry Voice-over';
  return 'Generate Voice-over';
}

function renderVoiceoverRow(job) {
  const isGenerating = generatingVoiceoverJobIds.has(job.id);
  const requestError = voiceoverGenerationRequestErrors.get(job.id);
  const voiceover = job.voiceover && typeof job.voiceover === 'object' ? job.voiceover : null;

  if (!isGenerating && !requestError && (!voiceover || voiceover.status === 'pending')) {
    return '';
  }

  let statusLabel = 'Ready';
  let statusClass = 'ready';

  if (isGenerating) {
    statusLabel = 'Generating';
    statusClass = 'generating';
  } else if (requestError) {
    statusLabel = 'Failed';
    statusClass = 'failed';
  } else if (voiceover && voiceover.status === 'completed') {
    statusLabel = 'Completed';
    statusClass = 'completed';
  } else if (voiceover && voiceover.status === 'failed') {
    statusLabel = 'Failed';
    statusClass = 'failed';
  }

  let body = '';
  if (isGenerating) {
    body =
      '<p class="generated-images-hint">Generating voice-over' +
      '<span class="generating-dots"><span></span><span></span><span></span></span></p>';
  } else if (voiceover && voiceover.status === 'completed' && voiceover.url) {
    const voiceLabel = voiceover.voiceStyle || voiceover.voice;
    body =
      `<audio class="generated-audio" controls src="${voiceover.url}"></audio>` +
      (voiceLabel ? `<p class="generated-images-hint">Voice: ${voiceLabel}</p>` : '');
  } else if (voiceover && voiceover.status === 'failed') {
    body = `<p class="generated-image-error">Failed: ${voiceover.error || 'Unknown error'}</p>`;
  }

  const requestErrorHtml = requestError
    ? `<p class="generated-images-error">${requestError}</p>`
    : '';

  return `
    <tr class="generated-images-row">
      <td colspan="8">
        <div class="generated-images-panel">
          <span class="generation-badge ${statusClass}">${statusLabel}</span>
          ${requestErrorHtml}
          ${body}
        </div>
      </td>
    </tr>
  `;
}

function renderJobs(jobs) {
  if (!jobs.length) {
    tableBody.innerHTML = '<tr><td colspan="8" class="dashboard-empty">No video jobs yet. Click "+ New Job" to create one.</td></tr>';
    return;
  }

  tableBody.innerHTML = jobs
    .map((job) => {
      const isLastStage = job.status === 'COMPLETED';
      const canGenerateImages = job.status === 'ASSET GENERATION';
      const hasPrompts = Array.isArray(job.imagePrompts) && job.imagePrompts.length > 0;
      const isGenerating = generatingImageJobIds.has(job.id);
      const hasScript = typeof job.script === 'string' && job.script.trim().length > 0;
      const isGeneratingVoiceover = generatingVoiceoverJobIds.has(job.id);

      return `
        <tr>
          <td>${job.id}</td>
          <td>${job.topic || job.videoTitle || '—'}</td>
          <td>${job.duration || '—'}</td>
          <td>${job.language || '—'}</td>
          <td>${job.storyStyle || '—'}</td>
          <td><span class="stage-badge">${job.status}</span></td>
          <td><span class="confirm-badge ${job.confirmed ? 'confirmed' : 'unconfirmed'}">${confirmationLabel(job)}</span></td>
          <td class="actions-cell">
            ${job.confirmed ? '' : `<button type="button" class="btn-confirm" data-id="${job.id}">Confirm</button>`}
            <button type="button" class="btn-advance" data-id="${job.id}" ${isLastStage ? 'disabled' : ''}>
              ${isLastStage ? 'Completed' : 'Advance →'}
            </button>
            ${
              canGenerateImages
                ? `<button type="button" class="btn-generate-images" data-id="${job.id}" ${isGenerating || !hasPrompts ? 'disabled' : ''}>
                    ${generateImagesButtonLabel(job, isGenerating, hasPrompts)}
                  </button>`
                : ''
            }
            ${
              hasScript
                ? `<button type="button" class="btn-generate-voiceover" data-id="${job.id}" ${isGeneratingVoiceover ? 'disabled' : ''}>
                    ${generateVoiceoverButtonLabel(job, isGeneratingVoiceover)}
                  </button>`
                : ''
            }
          </td>
        </tr>
      `.trim() + renderGenerationRow(job) + renderVoiceoverRow(job);
    })
    .join('');
}

async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const jobs = await res.json();
    lastJobs = jobs;
    renderJobs(jobs);
  } catch (error) {
    tableBody.innerHTML = '<tr><td colspan="8" class="dashboard-empty">Could not load jobs. Please try again.</td></tr>';
  }
}

function openNewJobForm() {
  newJobForm.hidden = false;
  newJobTopicInput.focus();
}

function closeNewJobForm() {
  newJobForm.reset();
  newJobForm.hidden = true;
}

async function createJob(event) {
  event.preventDefault();

  const topic = newJobTopicInput.value.trim();
  const duration = newJobDurationInput.value.trim();
  const language = newJobLanguageInput.value.trim();
  const style = newJobStyleInput.value.trim();

  const submitBtn = newJobForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const createRes = await fetch('/api/jobs', { method: 'POST' });
    const job = await createRes.json();

    if (!createRes.ok) {
      showMessage('Could not create a new job. Please try again.', 'error');
      return;
    }

    const patchRes = await fetch(`/api/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, duration, language, storyStyle: style }),
    });
    const patchData = await patchRes.json();

    if (!patchRes.ok) {
      showMessage(patchData.error || 'Job was created but its details could not be saved.', 'error');
    } else {
      clearMessage();
    }

    closeNewJobForm();
    await loadJobs();
  } catch (error) {
    showMessage('Could not create a new job. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function advanceJob(id, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/jobs/${id}/advance`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || 'Could not advance this job.', 'error');
    } else {
      clearMessage();
    }

    await loadJobs();
  } catch (error) {
    showMessage('Could not advance this job. Please try again.', 'error');
    button.disabled = false;
  }
}

async function confirmJob(id, button) {
  const confirmedByUser = window.confirm(
    'Confirm this video job? This records that the user has explicitly approved the final production details.'
  );

  if (!confirmedByUser) {
    return;
  }

  button.disabled = true;
  try {
    const res = await fetch(`/api/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || 'Could not confirm this job.', 'error');
    } else {
      clearMessage();
    }

    await loadJobs();
  } catch (error) {
    showMessage('Could not confirm this job. Please try again.', 'error');
    button.disabled = false;
  }
}

async function generateImages(id) {
  if (generatingImageJobIds.has(id)) {
    return;
  }

  generatingImageJobIds.add(id);
  imageGenerationRequestErrors.delete(id);
  renderJobs(lastJobs);

  try {
    const res = await fetch(`/api/jobs/${id}/generate-images`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      imageGenerationRequestErrors.set(id, data.error || 'Could not generate images.');
      showMessage(data.error || 'Could not generate images.', 'error');
    } else {
      clearMessage();
    }
  } catch (error) {
    imageGenerationRequestErrors.set(id, 'Could not generate images. Please try again.');
    showMessage('Could not generate images. Please try again.', 'error');
  } finally {
    generatingImageJobIds.delete(id);
    await loadJobs();
  }
}

async function generateVoiceover(id) {
  if (generatingVoiceoverJobIds.has(id)) {
    return;
  }

  generatingVoiceoverJobIds.add(id);
  voiceoverGenerationRequestErrors.delete(id);
  renderJobs(lastJobs);

  try {
    const res = await fetch(`/api/jobs/${id}/generate-voiceover`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      voiceoverGenerationRequestErrors.set(id, data.error || 'Could not generate voice-over.');
      showMessage(data.error || 'Could not generate voice-over.', 'error');
    } else if (data.voiceover && data.voiceover.status === 'completed') {
      showMessage('Voice-over generated successfully.', 'success');
    } else {
      // The request succeeded but OpenAI itself failed to produce audio;
      // the row already shows this from the persisted voiceover.error, so
      // only surface the top banner here, not a duplicate row-level error.
      showMessage((data.voiceover && data.voiceover.error) || 'Could not generate voice-over.', 'error');
    }
  } catch (error) {
    voiceoverGenerationRequestErrors.set(id, 'Could not generate voice-over. Please try again.');
    showMessage('Could not generate voice-over. Please try again.', 'error');
  } finally {
    generatingVoiceoverJobIds.delete(id);
    await loadJobs();
  }
}

newJobBtn.addEventListener('click', openNewJobForm);
newJobCancelBtn.addEventListener('click', closeNewJobForm);
newJobForm.addEventListener('submit', createJob);

tableBody.addEventListener('click', (event) => {
  const advanceBtn = event.target.closest('.btn-advance');
  if (advanceBtn && !advanceBtn.disabled) {
    advanceJob(advanceBtn.dataset.id, advanceBtn);
    return;
  }

  const confirmBtn = event.target.closest('.btn-confirm');
  if (confirmBtn && !confirmBtn.disabled) {
    confirmJob(confirmBtn.dataset.id, confirmBtn);
    return;
  }

  const generateBtn = event.target.closest('.btn-generate-images');
  if (generateBtn && !generateBtn.disabled) {
    generateImages(generateBtn.dataset.id);
    return;
  }

  const generateVoiceoverBtn = event.target.closest('.btn-generate-voiceover');
  if (generateVoiceoverBtn && !generateVoiceoverBtn.disabled) {
    generateVoiceover(generateVoiceoverBtn.dataset.id);
  }
});

loadJobs();
