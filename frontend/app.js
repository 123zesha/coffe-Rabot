// Control interface: submit a video idea, then poll and render stage progress.

const form = document.getElementById("generate-form");
const generateBtn = document.getElementById("generate-btn");
const progressSection = document.getElementById("progress");
const projectNameEl = document.getElementById("project-name");
const stageListEl = document.getElementById("stage-list");

const STATUS_LABELS = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  retrying: "Retrying",
};

let pollTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  generateBtn.disabled = true;
  generateBtn.textContent = "Starting...";

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: document.getElementById("topic").value,
        duration_minutes: Number(document.getElementById("duration").value),
        language: document.getElementById("language").value,
        style: document.getElementById("style").value,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Failed to start project");
    }

    const project = await response.json();
    projectNameEl.textContent = `Project: ${project.id}`;
    progressSection.classList.remove("hidden");
    startPolling(project.id);
  } catch (error) {
    alert(error.message);
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Video";
  }
});

function startPolling(projectId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => fetchStatus(projectId), 2000);
  fetchStatus(projectId);
}

async function fetchStatus(projectId) {
  const response = await fetch(`/api/projects/${projectId}`);
  if (!response.ok) return;
  const project = await response.json();
  renderStages(project.stages);

  const allDone = project.stages.every((stage) => stage.status === "completed");
  const anyFailed = project.stages.some((stage) => stage.status === "failed");

  if (allDone) {
    clearInterval(pollTimer);
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Video";
    projectNameEl.textContent += " — FINAL VIDEO READY FOR REVIEW";
  } else if (anyFailed) {
    clearInterval(pollTimer);
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Video";
  }
}

function renderStages(stages) {
  stageListEl.innerHTML = "";
  for (const stage of stages) {
    const item = document.createElement("li");
    item.className = `stage stage-${stage.status}`;
    item.innerHTML = `<span class="stage-label">${stage.label}</span>
      <span class="stage-status">${STATUS_LABELS[stage.status] || stage.status}</span>`;
    if (stage.error) {
      const errorEl = document.createElement("div");
      errorEl.className = "stage-error";
      errorEl.textContent = stage.error;
      item.appendChild(errorEl);
    }
    stageListEl.appendChild(item);
  }
}
