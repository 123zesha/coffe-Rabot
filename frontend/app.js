(function () {
  const ERROR_REPLY = "Sorry, I couldn't reach the AI Agent. Please check your connection and try again.";

  const toggleBtn = document.getElementById('chat-toggle');
  const windowEl = document.getElementById('chat-window');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = form.querySelector('.chat-send');
  const messages = document.getElementById('chat-messages');

  const generateBtn = document.getElementById('generate-video-btn');
  const generateStatus = document.getElementById('generate-status');
  const videoIdeaInput = document.getElementById('video-idea');
  const videoDurationSelect = document.getElementById('video-duration');
  const videoLanguageSelect = document.getElementById('video-language');
  const videoStyleSelect = document.getElementById('video-style');

  const voiceoverPlaceholder = document.getElementById('voiceover-placeholder');
  const voiceoverPanel = document.getElementById('voiceover-panel');
  const voiceoverAudio = document.getElementById('voiceover-audio');
  const generateVoiceoverBtn = document.getElementById('generate-voiceover-btn');
  const voiceoverStatus = document.getElementById('voiceover-status');

  const sceneClipsEmpty = document.getElementById('scene-clips-empty');
  const sceneClipsList = document.getElementById('scene-clips-list');

  const finalVideoPlaceholder = document.getElementById('final-video-placeholder');
  const finalVideoPanel = document.getElementById('final-video-panel');
  const finalVideoPlayer = document.getElementById('final-video-player');
  const finalVideoDownload = document.getElementById('final-video-download');
  const finalVideoStatus = document.getElementById('final-video-status');

  const JOB_ID_STORAGE_KEY = 'aiAgentJobId';

  function loadStoredJobId() {
    try {
      return localStorage.getItem(JOB_ID_STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function storeJobId(id) {
    try {
      localStorage.setItem(JOB_ID_STORAGE_KEY, id);
    } catch (error) {
      // Ignore storage failures (private browsing, disabled storage, etc.) —
      // the page still works within the current session either way.
    }
  }

  let conversationHistory = [];
  let jobId = loadStoredJobId();

  async function callAgent(message) {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationHistory, jobId }),
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();
    conversationHistory = Array.isArray(data.conversationHistory)
      ? data.conversationHistory
      : conversationHistory;
    if (data.jobId) {
      jobId = data.jobId;
      storeJobId(jobId);
    }
    return data.reply;
  }

  function addMessage(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + sender;
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function showTypingIndicator() {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bot chat-typing';
    bubble.setAttribute('aria-label', 'AI Agent is typing');
    bubble.innerHTML = '<span></span><span></span><span></span>';
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function openChat() {
    windowEl.hidden = false;
    requestAnimationFrame(() => windowEl.classList.add('open'));
    toggleBtn.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  function closeChat() {
    windowEl.classList.remove('open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    windowEl.addEventListener('transitionend', () => {
      if (!windowEl.classList.contains('open')) windowEl.hidden = true;
    }, { once: true });
  }

  toggleBtn.addEventListener('click', () => {
    if (windowEl.classList.contains('open')) {
      closeChat();
    } else {
      openChat();
    }
  });

  closeBtn.addEventListener('click', closeChat);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, 'user');
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    const typingBubble = showTypingIndicator();

    try {
      const reply = await callAgent(text);
      typingBubble.remove();
      addMessage(reply, 'bot');
    } catch (error) {
      typingBubble.remove();
      addMessage(ERROR_REPLY, 'bot');
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      refreshVoiceoverCard();
      refreshSceneClipsCard();
      refreshFinalVideoCard();
    }
  });

  function setGenerateStatus(text, type) {
    generateStatus.textContent = text;
    generateStatus.className = 'generate-status' + (type ? ' ' + type : '');
    generateStatus.hidden = false;
  }

  generateBtn.addEventListener('click', async () => {
    const topic = videoIdeaInput.value.trim();

    if (!topic) {
      setGenerateStatus('Please enter a video topic or story idea first.', 'error');
      videoIdeaInput.focus();
      return;
    }

    const durationOption = videoDurationSelect.selectedOptions[0];
    const languageOption = videoLanguageSelect.selectedOptions[0];
    const styleOption = videoStyleSelect.selectedOptions[0];

    const details = [`Topic or story idea: ${topic}`];
    if (videoDurationSelect.value) details.push(`Duration: ${durationOption.textContent}`);
    if (videoLanguageSelect.value) details.push(`Language: ${languageOption.textContent}`);
    if (videoStyleSelect.value) details.push(`Style: ${styleOption.textContent}`);

    const message = "I'd like to create a YouTube video with these details:\n" + details.join('\n');

    generateBtn.disabled = true;
    setGenerateStatus('Generating your video plan…', 'loading');

    try {
      const reply = await callAgent(message);
      setGenerateStatus(reply);
    } catch (error) {
      setGenerateStatus(ERROR_REPLY, 'error');
    } finally {
      generateBtn.disabled = false;
      refreshVoiceoverCard();
      refreshSceneClipsCard();
      refreshFinalVideoCard();
    }
  });

  // --- Voice-over (Final Review) ---
  // Mirrors the same generate/status pattern already used and tested on the
  // dashboard's per-job "Generate Voice-over" button, scoped to this page's
  // single current job. Calls the same POST /api/jobs/:id/generate-voiceover
  // route; nothing about job persistence, /api/agent, or stage validation is
  // touched here — this only adds a UI that was missing for this page.
  let voiceoverGenerating = false;

  function setVoiceoverStatus(text, type) {
    voiceoverStatus.textContent = text;
    voiceoverStatus.className = 'generate-status' + (type ? ' ' + type : '');
    voiceoverStatus.hidden = false;
  }

  function clearVoiceoverStatus() {
    voiceoverStatus.hidden = true;
    voiceoverStatus.textContent = '';
  }

  async function fetchCurrentJob() {
    if (!jobId) {
      return null;
    }
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) {
        return null;
      }
      return await res.json();
    } catch (error) {
      return null;
    }
  }

  // --- Resume an existing job after a page refresh ---
  // jobId survives a refresh (it's in localStorage), and the job's real
  // data survives in the backend regardless — but conversationHistory and
  // the visible chat transcript are plain in-memory/DOM state, never
  // persisted anywhere, so a refresh always starts both empty. That made
  // an existing job look "cleared" even though nothing was lost or
  // regenerated. This reads the job back (GET /api/jobs/:id — the same
  // read-only route the voice-over card already uses; no paid API call)
  // and posts one factual summary bubble from its real fields, so
  // resuming is visible instead of the chat window silently starting
  // blank. It does not reconstruct the prior message-by-message chat
  // transcript (that was never stored) or trigger any generation.
  function describeJobProgress(job) {
    const parts = [];

    if (job.script && job.script.trim()) {
      parts.push('a script');
    }
    if (Array.isArray(job.scenes) && job.scenes.length > 0) {
      parts.push(`${job.scenes.length} planned scene(s)`);
    }
    if (Array.isArray(job.imagePrompts) && job.imagePrompts.length > 0) {
      const completedImages = Array.isArray(job.images)
        ? job.images.filter((image) => image && image.status === 'completed').length
        : 0;
      parts.push(`${completedImages} of ${job.imagePrompts.length} scene image(s) generated`);
    }
    if (Array.isArray(job.videoPrompts) && job.videoPrompts.length > 0) {
      parts.push(`${job.videoPrompts.length} scene video prompt(s) set`);
    }
    if (job.videoGeneration && job.videoGeneration.status && job.videoGeneration.status !== 'not_started') {
      const completedClips = Array.isArray(job.videoGeneration.clips)
        ? job.videoGeneration.clips.filter((clip) => clip && clip.status === 'completed').length
        : 0;
      parts.push(`${completedClips} of ${job.videoGeneration.clips.length} scene video clip(s) generated`);
    }
    if (job.voiceover && job.voiceover.status === 'completed') {
      parts.push('a generated voice-over');
    }

    return parts;
  }

  function buildResumeSummary(job) {
    const stage = job.status || 'NEW';
    const progress = describeJobProgress(job);

    if (progress.length === 0) {
      return `Welcome back — resuming your existing job (stage: ${stage}). Nothing has been generated yet.`;
    }

    return `Welcome back — resuming your existing job (stage: ${stage}). So far it has: ${progress.join(', ')}. Nothing was lost or regenerated — just tell me what you'd like to do next.`;
  }

  async function restoreExistingJob() {
    if (!jobId) {
      return;
    }
    const job = await fetchCurrentJob();
    if (job) {
      addMessage(buildResumeSummary(job), 'bot');
    }
  }

  function renderVoiceoverCard(job) {
    const hasScript = Boolean(job && typeof job.script === 'string' && job.script.trim().length > 0);

    if (!hasScript) {
      voiceoverPlaceholder.hidden = false;
      voiceoverPanel.hidden = true;
      return;
    }

    voiceoverPlaceholder.hidden = true;
    voiceoverPanel.hidden = false;

    const voiceover = job.voiceover && typeof job.voiceover === 'object' ? job.voiceover : null;

    generateVoiceoverBtn.disabled = voiceoverGenerating;
    if (voiceoverGenerating) {
      generateVoiceoverBtn.textContent = 'Generating…';
    } else if (voiceover && voiceover.status === 'completed') {
      generateVoiceoverBtn.textContent = 'Regenerate Voice-over';
    } else if (voiceover && voiceover.status === 'failed') {
      generateVoiceoverBtn.textContent = 'Retry Voice-over';
    } else {
      generateVoiceoverBtn.textContent = 'Generate Voice-over';
    }

    // Only ever show the player when the job actually has a real,
    // successfully generated audio asset — never for 'pending' or 'failed'.
    if (voiceover && voiceover.status === 'completed' && voiceover.url) {
      voiceoverAudio.src = voiceover.url;
      voiceoverAudio.hidden = false;
    } else {
      voiceoverAudio.hidden = true;
      voiceoverAudio.removeAttribute('src');
    }
  }

  async function refreshVoiceoverCard() {
    const job = await fetchCurrentJob();
    renderVoiceoverCard(job);
  }

  // --- Scene video clips (Progress tab) ---
  // Renders a real <video> player for each scene clip the Agent has already
  // generated via generateSceneVideo — the clip's real URL already exists in
  // job.videoGeneration.clips[i].url (returned in full by GET /api/jobs/:id,
  // the same read-only route the voice-over card uses) but was previously
  // never shown anywhere: the chat tool deliberately strips it, and this tab
  // was a static, unwired placeholder. No paid API call is triggered by
  // viewing it; a still-processing or failed scene shows its status instead
  // of a player, never a fabricated link.
  function buildSceneClipCard(index, clip) {
    const card = document.createElement('div');
    card.className = 'scene-clip-card';

    const heading = document.createElement('h4');
    heading.textContent = `Scene ${index + 1}`;
    card.appendChild(heading);

    if (clip && clip.status === 'completed' && clip.url) {
      const video = document.createElement('video');
      video.className = 'scene-clip-video';
      video.controls = true;
      video.src = clip.url;
      card.appendChild(video);
    } else {
      const status = document.createElement('p');
      status.className = 'scene-clip-status' + (clip && clip.status === 'failed' ? ' error' : '');
      if (clip && clip.status === 'processing') {
        status.textContent = 'Generating…';
      } else if (clip && clip.status === 'failed') {
        status.textContent = `Failed: ${clip.error || 'video generation failed.'}`;
      } else {
        status.textContent = 'Not generated yet.';
      }
      card.appendChild(status);
    }

    return card;
  }

  function renderSceneClipsCard(job) {
    const clips =
      job && job.videoGeneration && Array.isArray(job.videoGeneration.clips) ? job.videoGeneration.clips : [];

    sceneClipsList.innerHTML = '';

    if (clips.length === 0) {
      sceneClipsEmpty.hidden = false;
      sceneClipsList.hidden = true;
      return;
    }

    sceneClipsEmpty.hidden = true;
    sceneClipsList.hidden = false;
    clips.forEach((clip, index) => {
      sceneClipsList.appendChild(buildSceneClipCard(index, clip));
    });
  }

  async function refreshSceneClipsCard() {
    renderSceneClipsCard(await fetchCurrentJob());
  }

  // --- Final assembled video (Final Review tab) ---
  // job.finalVideo.url is a real hosted reference (Vercel Blob in
  // production, or a /generated/... local path in dev — see
  // backend/video-storage.js) once assembleFinalVideo has actually
  // succeeded; this was previously a static, unwired placeholder, the same
  // gap the Progress tab's scene-clip viewer had before it was built. Only
  // ever shows a player/download link when finalVideo.status is genuinely
  // 'completed' with a real url — never for 'pending' or 'failed'.
  function renderFinalVideoCard(job) {
    const finalVideo = job && job.finalVideo && typeof job.finalVideo === 'object' ? job.finalVideo : null;

    if (!finalVideo || finalVideo.status === 'pending') {
      finalVideoPlaceholder.hidden = false;
      finalVideoPanel.hidden = true;
      return;
    }

    finalVideoPlaceholder.hidden = true;
    finalVideoPanel.hidden = false;

    if (finalVideo.status === 'completed' && finalVideo.url) {
      finalVideoPlayer.src = finalVideo.url;
      finalVideoPlayer.hidden = false;
      finalVideoDownload.href = finalVideo.url;
      finalVideoDownload.hidden = false;
      finalVideoStatus.hidden = true;
    } else {
      finalVideoPlayer.hidden = true;
      finalVideoPlayer.removeAttribute('src');
      finalVideoDownload.hidden = true;
      finalVideoStatus.textContent = `Final video assembly failed: ${finalVideo.error || 'unknown error'}`;
      finalVideoStatus.className = 'generate-status error';
      finalVideoStatus.hidden = false;
    }
  }

  async function refreshFinalVideoCard() {
    renderFinalVideoCard(await fetchCurrentJob());
  }

  generateVoiceoverBtn.addEventListener('click', async () => {
    if (voiceoverGenerating || !jobId) {
      return;
    }

    voiceoverGenerating = true;
    clearVoiceoverStatus();
    renderVoiceoverCard(await fetchCurrentJob());

    try {
      const res = await fetch(`/api/jobs/${jobId}/generate-voiceover`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        setVoiceoverStatus(data.error || 'Could not generate voice-over.', 'error');
      } else if (data.voiceover && data.voiceover.status === 'completed') {
        setVoiceoverStatus('Voice-over generated successfully.', 'success');
      } else {
        setVoiceoverStatus((data.voiceover && data.voiceover.error) || 'Could not generate voice-over.', 'error');
      }
    } catch (error) {
      setVoiceoverStatus('Could not generate voice-over. Please try again.', 'error');
    } finally {
      voiceoverGenerating = false;
      await refreshVoiceoverCard();
    }
  });

  restoreExistingJob();
  refreshVoiceoverCard();
  refreshSceneClipsCard();
  refreshFinalVideoCard();
})();
