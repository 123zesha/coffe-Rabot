const tableBody = document.getElementById('jobs-table-body');
const newJobBtn = document.getElementById('new-job-btn');

function statusLabel(job) {
  if (job.status === 'COMPLETED') {
    return 'Completed';
  }
  return job.confirmed ? 'Confirmed' : 'In Progress';
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
          <td>${statusLabel(job)}</td>
          <td>
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
    await fetch(`/api/jobs/${id}/advance`, { method: 'POST' });
    await loadJobs();
  } catch (error) {
    button.disabled = false;
  }
}

newJobBtn.addEventListener('click', createJob);

tableBody.addEventListener('click', (event) => {
  const button = event.target.closest('.btn-advance');
  if (button && !button.disabled) {
    advanceJob(button.dataset.id, button);
  }
});

loadJobs();
