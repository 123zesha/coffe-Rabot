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
  const videoGenerationModeSelect = document.getElementById('video-generation-mode');
  const videoDurationSelect = document.getElementById('video-duration');
  const videoLanguageSelect = document.getElementById('video-language');
  const videoStyleSelect = document.getElementById('video-style');
  const videoOutputFormatSelect = document.getElementById('video-output-format');
  const videoResolutionSelect = document.getElementById('video-resolution');
  const referenceVideoUrlInput = document.getElementById('reference-video-url');
  const referenceVideoNotesInput = document.getElementById('reference-video-notes');
  const generateYoutubePackageToggle = document.getElementById('generate-youtube-package-toggle');
  const musicEnabledToggle = document.getElementById('music-enabled-toggle');
  const videoMusicTrackSelect = document.getElementById('video-music-track');

  const youtubeThumbnailPlaceholder = document.getElementById('youtube-thumbnail-placeholder');
  const youtubeThumbnailPanel = document.getElementById('youtube-thumbnail-panel');
  const youtubeThumbnailImage = document.getElementById('youtube-thumbnail-image');
  const youtubeThumbnailConcept = document.getElementById('youtube-thumbnail-concept');
  const youtubeTitlesPlaceholder = document.getElementById('youtube-titles-placeholder');
  const youtubeTitlesList = document.getElementById('youtube-titles-list');
  const youtubeDescriptionPlaceholder = document.getElementById('youtube-description-placeholder');
  const youtubeDescriptionPanel = document.getElementById('youtube-description-panel');
  const youtubeDescriptionText = document.getElementById('youtube-description-text');
  const youtubeTagsText = document.getElementById('youtube-tags-text');
  const generateYoutubePackageBtn = document.getElementById('generate-youtube-package-btn');
  const youtubePackageStatus = document.getElementById('youtube-package-status');

  const voiceoverPlaceholder = document.getElementById('voiceover-placeholder');
  const voiceoverPanel = document.getElementById('voiceover-panel');
  const voiceoverAudio = document.getElementById('voiceover-audio');
  const generateVoiceoverBtn = document.getElementById('generate-voiceover-btn');
  const voiceoverStatus = document.getElementById('voiceover-status');

  const subtitlesPlaceholder = document.getElementById('subtitles-placeholder');
  const subtitlesPanel = document.getElementById('subtitles-panel');
  const subtitlesTextarea = document.getElementById('subtitles-textarea');
  const subtitlesDownload = document.getElementById('subtitles-download');
  const generateSubtitlesBtn = document.getElementById('generate-subtitles-btn');
  const burnInSubtitlesToggle = document.getElementById('burn-in-subtitles-toggle');
  const subtitlesStatus = document.getElementById('subtitles-status');

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

  async function postAgentRequest(payload) {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    return response.json();
  }

  function applyAgentResponse(data) {
    conversationHistory = Array.isArray(data.conversationHistory)
      ? data.conversationHistory
      : conversationHistory;
    if (data.jobId) {
      jobId = data.jobId;
      storeJobId(jobId);
    }
  }

  // Voice-over generation, subtitle transcription, and final video assembly
  // are each slow enough (real OpenAI calls, or several minutes of real
  // ffmpeg encoding for a 15-20 minute video) that the backend only ever
  // runs ONE of them per /api/agent request and reports autoContinue: true
  // when another is still pending (see server.js's HEAVY_TOOLS guard) —
  // otherwise a single request chaining all of them could exceed the
  // serverless function's time limit. This resumes those follow-up steps
  // automatically as separate requests, so from the user's side, sending
  // one message still produces one complete video with no extra prompts.
  // onProgress, if given, is called with each intermediate step's reply as
  // it completes (the final reply is returned normally, not passed here).
  async function callAgent(message, onProgress) {
    let data = await postAgentRequest({ message, conversationHistory, jobId });
    applyAgentResponse(data);

    while (data.autoContinue) {
      if (onProgress) onProgress(data.reply);
      data = await postAgentRequest({ conversationHistory, jobId, continueAutomatically: true });
      applyAgentResponse(data);
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

    let typingBubble = showTypingIndicator();

    try {
      const reply = await callAgent(text, (progressReply) => {
        typingBubble.remove();
        addMessage(progressReply, 'bot');
        typingBubble = showTypingIndicator();
      });
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
      refreshYoutubePackageCard();
      refreshSubtitlesCard();
    }
  });

  // Populates the local music-track picker from the same user-maintained
  // library (data/music/manifest.json, via GET /api/video-options) the
  // Agent's getVideoOptions tool uses — this app never bundles, downloads,
  // or generates music, so the list is often empty; the select/checkbox
  // stay disabled/off in that case rather than offering a track that
  // doesn't exist.
  (async () => {
    try {
      const res = await fetch('/api/video-options');
      if (!res.ok) return;
      const options = await res.json();
      const tracks = Array.isArray(options.musicTrackOptions) ? options.musicTrackOptions : [];

      if (tracks.length > 0) {
        videoMusicTrackSelect.innerHTML = '';
        for (const track of tracks) {
          const optionEl = document.createElement('option');
          optionEl.value = track.value;
          optionEl.textContent = track.label;
          videoMusicTrackSelect.appendChild(optionEl);
        }
        videoMusicTrackSelect.disabled = !musicEnabledToggle.checked;
        musicEnabledToggle.disabled = false;
      } else {
        musicEnabledToggle.disabled = true;
        musicEnabledToggle.checked = false;
      }
    } catch (error) {
      // No local video-options available (offline dev, etc.) — leave the
      // music controls in their default off/disabled state.
    }
  })();

  musicEnabledToggle.addEventListener('change', () => {
    videoMusicTrackSelect.disabled = !musicEnabledToggle.checked;
  });

  function setGenerateStatus(text, type) {
    generateStatus.textContent = text;
    generateStatus.className = 'generate-status' + (type ? ' ' + type : '');
    generateStatus.hidden = false;
  }

  const DEFAULT_OUTPUT_FORMAT = 'horizontal';

  // Starts a brand-new, empty job (POST /api/jobs — a local, free call; no
  // paid API involved) and points this page at it. Without this, clicking
  // "Generate Video" kept reusing whatever jobId was already sitting in
  // localStorage from a previous, possibly unrelated video — so a new
  // request could silently inherit that old job's images, voice-over,
  // video clips, final MP4, and even its outputFormat. A fresh job has none
  // of that (see job-store.js's createDefaultJob), so starting one here
  // guarantees a clean slate every time this form is submitted.
  async function startFreshJob() {
    const res = await fetch('/api/jobs', { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Could not create a new job (status ${res.status})`);
    }
    const job = await res.json();
    jobId = job.id;
    storeJobId(jobId);
    conversationHistory = [];
    return job;
  }

  generateBtn.addEventListener('click', async () => {
    const topic = videoIdeaInput.value.trim();

    if (!topic) {
      setGenerateStatus('Please enter a video topic or story idea first.', 'error');
      videoIdeaInput.focus();
      return;
    }

    generateBtn.disabled = true;
    setGenerateStatus('Starting a new video job…', 'loading');

    try {
      await startFreshJob();
    } catch (error) {
      setGenerateStatus('Could not start a new video job. Please try again.', 'error');
      generateBtn.disabled = false;
      return;
    }

    // The select's empty value means "Horizontal (16:9, default)" — map it
    // to the real outputFormat value explicitly and PATCH it onto the new
    // job directly (the same deterministic pattern burnInSubtitlesToggle
    // below already uses for a plain preference field), so the exact format
    // chosen in this form is always what actually gets saved — never left
    // to the chat message being parsed correctly, and never left ambiguous
    // with "not specified". videoMode is included in the same PATCH for the
    // same reason: which pipeline (and whether Runway is ever used at all)
    // must never depend on the chat message being parsed correctly.
    const outputFormat = videoOutputFormatSelect.value || DEFAULT_OUTPUT_FORMAT;
    const videoMode = videoGenerationModeSelect.value;
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputFormat, videoMode }),
      });
    } catch (error) {
      setGenerateStatus('Could not save the selected video generation mode/output format. Please try again.', 'error');
      generateBtn.disabled = false;
      return;
    }

    const durationOption = videoDurationSelect.selectedOptions[0];
    const languageOption = videoLanguageSelect.selectedOptions[0];
    const styleOption = videoStyleSelect.selectedOptions[0];

    const details = [`Topic or story idea: ${topic}`];
    // videoMode itself is already saved for real above — mentioned here so
    // the agent's own narration/plan (and, for 'simple-story', its script
    // length target and skipped asset-generation steps) matches what was
    // actually picked, and only when non-default so the message stays
    // unchanged for the common "AI Cinematic Video" case.
    if (videoMode === 'simple-story') {
      const modeOption = videoGenerationModeSelect.selectedOptions[0];
      details.push(`Video generation mode: ${modeOption.textContent}`);
    }
    if (videoDurationSelect.value) details.push(`Duration: ${durationOption.textContent}`);
    if (videoLanguageSelect.value) details.push(`Language: ${languageOption.textContent}`);
    if (videoStyleSelect.value) details.push(`Style: ${styleOption.textContent}`);

    // outputFormat itself is already saved for real above — this is only
    // mentioned in the message (when non-default) so the agent's own
    // narration of the plan stays consistent with what was picked.
    if (videoOutputFormatSelect.value) {
      const outputFormatOption = videoOutputFormatSelect.selectedOptions[0];
      details.push(`Output format: ${outputFormatOption.textContent}`);
    }

    // Same "only mention if non-default" pattern as output format above —
    // resolutionTier only upscales the final export (see index.html's field
    // hint); omitting this leaves the job at its default '720p'.
    if (videoResolutionSelect.value) {
      const resolutionOption = videoResolutionSelect.selectedOptions[0];
      details.push(`Resolution: ${resolutionOption.value} (an upscale of the same generated footage, not higher-detail source video)`);
    }

    // Both optional — "Reference Video / Inspiration Mode" only kicks in
    // when a URL is actually provided; omitting both leaves this message
    // identical to the existing flow.
    const referenceVideoUrl = referenceVideoUrlInput.value.trim();
    const referenceVideoNotes = referenceVideoNotesInput.value.trim();
    if (referenceVideoUrl) {
      details.push(`Reference video URL (use only as general storytelling-format inspiration, never copy it): ${referenceVideoUrl}`);
    }
    if (referenceVideoNotes) {
      details.push(`Reference notes: ${referenceVideoNotes}`);
    }

    // Optional "YouTube Publishing Package" — off by default. Described in
    // plain text like every other preference here; the Agent (per
    // prompts/system-prompt.md) records it with updateVideoJob and only
    // generates the package once a real script exists.
    if (generateYoutubePackageToggle.checked) {
      details.push(
        'Generate YouTube Package: yes — please also prepare 3 YouTube title options, an SEO-friendly ' +
          'description, tags, and an original thumbnail for this video once it is finished (update the ' +
          'job setting accordingly).'
      );
    }

    // Optional background music — off by default. Only mentioned when
    // actually enabled with a real track selected, so an unchecked/empty
    // state leaves this message identical to the existing flow (see
    // prompts/system-prompt.md's Background Music section for how the
    // Agent records/applies this).
    if (musicEnabledToggle.checked && videoMusicTrackSelect.value) {
      const trackOption = videoMusicTrackSelect.selectedOptions[0];
      details.push(`Background music: yes — use the local track "${trackOption.textContent}" for this video.`);
    }

    const message = "I'd like to create a YouTube video with these details:\n" + details.join('\n');

    generateBtn.disabled = true;
    setGenerateStatus('Generating your video plan…', 'loading');

    try {
      const reply = await callAgent(message, (progressReply) => {
        setGenerateStatus(progressReply, 'loading');
        refreshVoiceoverCard();
        refreshSceneClipsCard();
        refreshFinalVideoCard();
        refreshYoutubePackageCard();
        refreshSubtitlesCard();
      });
      setGenerateStatus(reply);
    } catch (error) {
      setGenerateStatus(ERROR_REPLY, 'error');
    } finally {
      generateBtn.disabled = false;
      refreshVoiceoverCard();
      refreshSceneClipsCard();
      refreshFinalVideoCard();
      refreshYoutubePackageCard();
      refreshSubtitlesCard();
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
  //
  // 'processing' (Simple Story Video mode only — see
  // continueSimpleStoryVideoAssembly in backend/simple-story-video.js) means
  // a real render is under way but a long story can need more than one
  // assembleFinalVideo call to finish; job.simpleStoryRender carries the
  // real completed/total section counts. This never holds one HTTP request
  // open waiting for the whole thing — pollSimpleStoryRenderProgress below
  // drives it forward with its own separate, short POSTs instead.
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
    } else if (finalVideo.status === 'processing') {
      finalVideoPlayer.hidden = true;
      finalVideoPlayer.removeAttribute('src');
      finalVideoDownload.hidden = true;
      const render = job.simpleStoryRender;
      const completed = render && Array.isArray(render.sections) ? render.sections.filter((s) => s && s.status === 'completed').length : 0;
      const total = render && typeof render.totalSections === 'number' ? render.totalSections : null;
      finalVideoStatus.textContent = total
        ? `Rendering final video… ${completed}/${total} section(s) done so far. This can take a few minutes for a long story.`
        : 'Rendering final video…';
      finalVideoStatus.className = 'generate-status loading';
      finalVideoStatus.hidden = false;
    } else {
      finalVideoPlayer.hidden = true;
      finalVideoPlayer.removeAttribute('src');
      finalVideoDownload.hidden = true;
      finalVideoStatus.textContent = `Final video assembly failed: ${finalVideo.error || 'unknown error'}`;
      finalVideoStatus.className = 'generate-status error';
      finalVideoStatus.hidden = false;
    }
  }

  // Drives Simple Story Video's resumable render to completion with plain,
  // separate HTTP calls on a timer — never by looping the conversational
  // agent purely to advance a mechanical render with nothing left to
  // reason about (that would cost a real Claude call per step for no
  // reason). Guarded by simpleStoryPollTimer so a chat-triggered render and
  // a page reload can never start two overlapping polling loops for the
  // same job. Stops itself the moment the job's own state is no longer
  // 'processing' — a network hiccup on one poll is not fatal, the next
  // scheduled poll (or a manual page refresh) just tries again.
  let simpleStoryPollTimer = null;
  const SIMPLE_STORY_POLL_INTERVAL_MS = 4000;

  function pollSimpleStoryRenderProgress(job) {
    const finalVideo = job && job.finalVideo;
    if (!jobId || !finalVideo || finalVideo.status !== 'processing' || simpleStoryPollTimer) {
      return;
    }

    simpleStoryPollTimer = setTimeout(async () => {
      simpleStoryPollTimer = null;
      try {
        await fetch(`/api/jobs/${jobId}/assemble-video`, { method: 'POST' });
      } catch (error) {
        // Ignored — the job's own real, persisted state (checked on the
        // next poll or the next page load) is the source of truth, not
        // this fire-and-forget continuation call.
      }
      await refreshFinalVideoCard();
    }, SIMPLE_STORY_POLL_INTERVAL_MS);
  }

  async function refreshFinalVideoCard() {
    const job = await fetchCurrentJob();
    renderFinalVideoCard(job);
    pollSimpleStoryRenderProgress(job);
  }

  // --- YouTube Publishing Package (Final Review) ---
  // Mirrors the voice-over card's generate/status pattern. job.youtubePackage
  // is returned in full (thumbnailUrl included) by GET /api/jobs/:id — the
  // same read-only route already used for voiceover.url/finalVideo.url —
  // and calls the same POST /api/jobs/:id/generate-youtube-package route the
  // generateYoutubePackage Agent tool also uses. Nothing here changes when
  // the toggle is off: the button is simply never clicked, so no call is
  // ever made unless the user explicitly asks for one.
  let youtubePackageGenerating = false;

  function setYoutubePackageStatus(text, type) {
    youtubePackageStatus.textContent = text;
    youtubePackageStatus.className = 'generate-status' + (type ? ' ' + type : '');
    youtubePackageStatus.hidden = false;
  }

  function clearYoutubePackageStatus() {
    youtubePackageStatus.hidden = true;
    youtubePackageStatus.textContent = '';
  }

  function renderYoutubePackageCard(job) {
    const hasScript = Boolean(job && typeof job.script === 'string' && job.script.trim().length > 0);
    const pkg = job && job.youtubePackage && typeof job.youtubePackage === 'object' ? job.youtubePackage : null;

    generateYoutubePackageBtn.disabled = youtubePackageGenerating || !hasScript;
    generateYoutubePackageBtn.textContent = youtubePackageGenerating
      ? 'Generating…'
      : pkg && pkg.status === 'completed'
      ? 'Regenerate YouTube Package'
      : 'Generate YouTube Package';

    const titles = pkg && Array.isArray(pkg.titles) ? pkg.titles : [];
    if (titles.length > 0) {
      youtubeTitlesPlaceholder.hidden = true;
      youtubeTitlesList.hidden = false;
      youtubeTitlesList.innerHTML = '';
      titles.forEach((title) => {
        const item = document.createElement('li');
        item.textContent = title;
        youtubeTitlesList.appendChild(item);
      });
    } else {
      youtubeTitlesPlaceholder.hidden = false;
      youtubeTitlesList.hidden = true;
    }

    if (pkg && pkg.description) {
      youtubeDescriptionPlaceholder.hidden = true;
      youtubeDescriptionPanel.hidden = false;
      youtubeDescriptionText.textContent = pkg.description;
      youtubeTagsText.textContent =
        Array.isArray(pkg.tags) && pkg.tags.length > 0 ? `Tags: ${pkg.tags.join(', ')}` : '';
    } else {
      youtubeDescriptionPlaceholder.hidden = false;
      youtubeDescriptionPanel.hidden = true;
    }

    if (pkg && pkg.thumbnailUrl) {
      youtubeThumbnailPlaceholder.hidden = true;
      youtubeThumbnailPanel.hidden = false;
      youtubeThumbnailImage.src = pkg.thumbnailUrl;
      youtubeThumbnailImage.hidden = false;
      youtubeThumbnailConcept.textContent = pkg.thumbnailConcept || '';
    } else if (pkg && pkg.thumbnailConcept) {
      // The text package succeeded but no thumbnail image exists (e.g. the
      // image provider isn't configured, or it failed) — still show the
      // real concept text rather than falling back to the empty placeholder.
      youtubeThumbnailPlaceholder.hidden = true;
      youtubeThumbnailPanel.hidden = false;
      youtubeThumbnailImage.hidden = true;
      youtubeThumbnailImage.removeAttribute('src');
      youtubeThumbnailConcept.textContent = pkg.thumbnailConcept;
    } else {
      youtubeThumbnailPlaceholder.hidden = false;
      youtubeThumbnailPanel.hidden = true;
    }

    if (pkg && pkg.status === 'failed' && pkg.error) {
      setYoutubePackageStatus(pkg.error, 'error');
    }
  }

  async function refreshYoutubePackageCard() {
    renderYoutubePackageCard(await fetchCurrentJob());
  }

  generateYoutubePackageBtn.addEventListener('click', async () => {
    if (youtubePackageGenerating || !jobId) {
      return;
    }

    const currentJob = await fetchCurrentJob();
    // Clicking again after a package already exists is an explicit request
    // to redo it — pass forceRegenerate so the backend's skip-if-unchanged
    // guard doesn't just return the same result again.
    const alreadyCompleted = Boolean(
      currentJob && currentJob.youtubePackage && currentJob.youtubePackage.status === 'completed'
    );

    youtubePackageGenerating = true;
    clearYoutubePackageStatus();
    renderYoutubePackageCard(currentJob);

    try {
      const res = await fetch(`/api/jobs/${jobId}/generate-youtube-package`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRegenerate: alreadyCompleted }),
      });
      const data = await res.json();

      if (!res.ok) {
        setYoutubePackageStatus(data.error || 'Could not generate the YouTube package.', 'error');
      } else if (data.youtubePackage && data.youtubePackage.status === 'completed') {
        setYoutubePackageStatus('YouTube package generated successfully.', 'success');
      } else {
        setYoutubePackageStatus(
          (data.youtubePackage && data.youtubePackage.error) || 'Could not generate the YouTube package.',
          'error'
        );
      }
    } catch (error) {
      setYoutubePackageStatus('Could not generate the YouTube package. Please try again.', 'error');
    } finally {
      youtubePackageGenerating = false;
      await refreshYoutubePackageCard();
    }
  });

  // --- Subtitles (Final Review) ---
  // Real subtitles transcribed from the job's own voice-over audio (never
  // guessed from the script) — see backend/subtitles-generation.js. Mirrors
  // the voice-over/YouTube-package cards' generate/status pattern. The
  // burn-in checkbox is a direct PATCH of the job's burnInSubtitles field
  // (the existing generic PATCH /api/jobs/:id route already accepts it —
  // job-store.js's JOB_FIELDS whitelist), not a chat message: it's a plain
  // preference toggle with no generation attached, so there's no need to
  // route it through the Agent the way the Create Video form's checkboxes
  // (read only at video-creation time) do.
  let subtitlesGenerating = false;

  function setSubtitlesStatus(text, type) {
    subtitlesStatus.textContent = text;
    subtitlesStatus.className = 'generate-status' + (type ? ' ' + type : '');
    subtitlesStatus.hidden = false;
  }

  function clearSubtitlesStatus() {
    subtitlesStatus.hidden = true;
    subtitlesStatus.textContent = '';
  }

  function renderSubtitlesCard(job) {
    const hasCompletedVoiceover = Boolean(job && job.voiceover && job.voiceover.status === 'completed' && job.voiceover.url);
    const subtitles = job && job.subtitles && typeof job.subtitles === 'object' ? job.subtitles : null;

    if (!hasCompletedVoiceover) {
      subtitlesPlaceholder.hidden = false;
      subtitlesPanel.hidden = true;
      return;
    }

    subtitlesPlaceholder.hidden = true;
    subtitlesPanel.hidden = false;

    generateSubtitlesBtn.disabled = subtitlesGenerating;
    generateSubtitlesBtn.textContent = subtitlesGenerating
      ? 'Generating…'
      : subtitles && subtitles.status === 'completed'
      ? 'Regenerate Subtitles'
      : 'Generate Subtitles';

    burnInSubtitlesToggle.checked = Boolean(job.burnInSubtitles);

    if (subtitles && subtitles.status === 'completed' && subtitles.content) {
      subtitlesTextarea.value = subtitles.content;
      subtitlesTextarea.hidden = false;
      subtitlesDownload.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(subtitles.content);
      subtitlesDownload.hidden = false;
    } else {
      subtitlesTextarea.value = '';
      subtitlesTextarea.hidden = true;
      subtitlesDownload.hidden = true;
      subtitlesDownload.removeAttribute('href');
    }

    if (subtitles && subtitles.status === 'failed' && subtitles.error) {
      setSubtitlesStatus(subtitles.error, 'error');
    }
  }

  async function refreshSubtitlesCard() {
    renderSubtitlesCard(await fetchCurrentJob());
  }

  generateSubtitlesBtn.addEventListener('click', async () => {
    if (subtitlesGenerating || !jobId) {
      return;
    }

    const currentJob = await fetchCurrentJob();
    // Clicking again once subtitles already exist is an explicit request to
    // redo them — force past the skip-if-unchanged guard, same reasoning as
    // the YouTube package button.
    const alreadyCompleted = Boolean(
      currentJob && currentJob.subtitles && currentJob.subtitles.status === 'completed'
    );

    subtitlesGenerating = true;
    clearSubtitlesStatus();
    renderSubtitlesCard(currentJob);

    try {
      const res = await fetch(`/api/jobs/${jobId}/generate-subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRegenerate: alreadyCompleted }),
      });
      const data = await res.json();

      if (!res.ok) {
        setSubtitlesStatus(data.error || 'Could not generate subtitles.', 'error');
      } else if (data.subtitles && data.subtitles.status === 'completed') {
        setSubtitlesStatus('Subtitles generated successfully.', 'success');
      } else {
        setSubtitlesStatus((data.subtitles && data.subtitles.error) || 'Could not generate subtitles.', 'error');
      }
    } catch (error) {
      setSubtitlesStatus('Could not generate subtitles. Please try again.', 'error');
    } finally {
      subtitlesGenerating = false;
      await refreshSubtitlesCard();
    }
  });

  burnInSubtitlesToggle.addEventListener('change', async () => {
    if (!jobId) {
      return;
    }
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ burnInSubtitles: burnInSubtitlesToggle.checked }),
      });
    } catch (error) {
      // Best-effort — if this fails the checkbox simply reverts on the next
      // refresh, since it always renders from the real job state.
    } finally {
      await refreshSubtitlesCard();
    }
  });

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
      // A successful/failed voice-over regeneration can change whether
      // subtitles can be generated at all, and any successful regeneration
      // resets existing subtitles server-side — refresh this card too so
      // that's reflected immediately.
      await refreshSubtitlesCard();
    }
  });

  restoreExistingJob();
  refreshVoiceoverCard();
  refreshSceneClipsCard();
  refreshFinalVideoCard();
  refreshYoutubePackageCard();
  refreshSubtitlesCard();
})();
