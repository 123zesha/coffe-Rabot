const tableBody = document.getElementById('jobs-table-body');
const newJobBtn = document.getElementById('new-job-btn');
const messageEl = document.getElementById('dashboard-message');

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

async function createJob() {
  newJobBtn.disabled = true;
  try {
    await fetch('/api/jobs', { method: 'POST' });
    await loadJobs();
  } catch (error) {
    // ignore; table stays in its last known state
  } finally {
    newJobBtn.disabled = false;
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

newJobBtn.addEventListener('click', createJob);

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
