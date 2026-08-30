const tableBody = document.getElementById('jobs-table-body');
const newJobBtn = document.getElementById('new-job-btn');
const messageEl = document.getElementById('dashboard-message');
const newJobForm = document.getElementById('new-job-form');
const newJobCancelBtn = document.getElementById('new-job-cancel');
const newJobTopicInput = document.getElementById('new-job-topic');
const newJobDurationInput = document.getElementById('new-job-duration');
const newJobLanguageInput = document.getElementById('new-job-language');
const newJobStyleInput = document.getElementById('new-job-style');

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

function renderJobs(jobs) {
  if (!jobs.length) {
    tableBody.innerHTML = '<tr><td colspan="8" class="dashboard-empty">No video jobs yet. Click "+ New Job" to create one.</td></tr>';
    return;
  }

  tableBody.innerHTML = jobs
    .map((job) => {
      const isLastStage = job.status === 'COMPLETED';
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
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const jobs = await res.json();
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
  }
});

loadJobs();
