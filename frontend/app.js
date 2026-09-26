(function () {
  const ERROR_REPLY = "Sorry, I couldn't reach the AI Agent. Please check your connection and try again.";

  const toggleBtn = document.getElementById('chat-toggle');
  const windowEl = document.getElementById('chat-window');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = form.querySelector('.chat-send');
  const messages = document.getElementById('chat-messages');
  const scriptPasteToggle = document.getElementById('script-paste-toggle');
  const scriptPasteHint = document.getElementById('script-paste-hint');

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

  // --- Story to Video ---
  const modeIdeaBtn = document.getElementById('mode-idea-btn');
  const modeStoryBtn = document.getElementById('mode-story-btn');
  const ideaModePanel = document.getElementById('idea-mode-panel');
  const storyModePanel = document.getElementById('story-mode-panel');
  const storyFormFields = document.getElementById('story-form-fields');
  const storyScriptInput = document.getElementById('story-script');
  const storyScriptWordcount = document.getElementById('story-script-wordcount');
  const voiceSourceAiRadio = document.getElementById('voice-source-ai');
  const voiceSourceUploadRadio = document.getElementById('voice-source-upload');
  const aiVoiceOptions = document.getElementById('ai-voice-options');
  const uploadVoiceOptions = document.getElementById('upload-voice-options');
  const storyVoiceStyleSelect = document.getElementById('story-voice-style');
  const storyVoiceSpeedSelect = document.getElementById('story-voice-speed');
  const storyVoiceSpeedCustomInput = document.getElementById('story-voice-speed-custom');
  const storyVoiceUploadInput = document.getElementById('story-voice-upload');
  const storyVoiceUploadStatus = document.getElementById('story-voice-upload-status');
  const storyBackgroundSelect = document.getElementById('story-background');
  const storyBackgroundCustomInput = document.getElementById('story-background-custom');
  const storyTextSizeSelect = document.getElementById('story-text-size');
  const storyShowCaptionsToggle = document.getElementById('story-show-captions');
  const storyDurationSelect = document.getElementById('story-duration');
  const storyDurationCustomInput = document.getElementById('story-duration-custom');
  const storyLanguageSelect = document.getElementById('story-language');
  const storyMusicEnabledToggle = document.getElementById('story-music-enabled-toggle');
  const storyMusicOptions = document.getElementById('story-music-options');
  const musicSourceUploadRadio = document.getElementById('music-source-upload');
  const musicSourceLibraryRadio = document.getElementById('music-source-library');
  const musicUploadOptions = document.getElementById('music-upload-options');
  const musicLibraryOptions = document.getElementById('music-library-options');
  const storyMusicUploadInput = document.getElementById('story-music-upload');
  const storyMusicUploadStatus = document.getElementById('story-music-upload-status');
  const storyMusicTrackSelect = document.getElementById('story-music-track');
  const storyMusicVolumeInput = document.getElementById('story-music-volume');
  const storyMusicVolumeValue = document.getElementById('story-music-volume-value');
  const storyNarrationVolumeInput = document.getElementById('story-narration-volume');
  const storyNarrationVolumeValue = document.getElementById('story-narration-volume-value');
  const storyYoutubePackageToggle = document.getElementById('story-youtube-package-toggle');
  const storyReviewCostBtn = document.getElementById('story-review-cost-btn');
  const storyCostReview = document.getElementById('story-cost-review');
  const storySettingsSummaryList = document.getElementById('story-settings-summary-list');
  const storyCostBreakdownList = document.getElementById('story-cost-breakdown-list');
  const storyCostTotal = document.getElementById('story-cost-total');
  const storyMaxBudgetInput = document.getElementById('story-max-budget');
  const storyApproveBtn = document.getElementById('story-approve-btn');
  const storyCancelReviewBtn = document.getElementById('story-cancel-review-btn');
  const storyCostStatus = document.getElementById('story-cost-status');

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
  // Chat-to-Video cost optimization: reads whatever the Create Video form's
  // own settings selectors currently show (mode, output format,
  // resolution, language, style, music) — the user can set these BEFORE
  // switching to the chat box to paste a script, and the backend applies
  // them directly to the new job (see sanitizeScriptPasteSettings in
  // server.js) instead of leaving Claude to infer/ask about them from the
  // pasted text. Only a select's non-empty value is included, the same
  // "only mention if actually set" pattern the Create Video form's own
  // generateBtn handler already uses below — an untouched field is left
  // out entirely so the backend/Claude's existing defaults (e.g.
  // simple-story for a plain narration script) still apply. videoMode is
  // only included when it's 'simple-story': the select always shows a real
  // value with no neutral "unspecified" option, so 'cinematic' can't be
  // told apart from "never touched" — see server.js's own comment on this.
  function collectScriptPasteFormSettings() {
    const settings = {};
    if (videoGenerationModeSelect.value === 'simple-story') {
      settings.videoMode = 'simple-story';
    }
    if (videoOutputFormatSelect.value) {
      settings.outputFormat = videoOutputFormatSelect.value;
    }
    if (videoResolutionSelect.value) {
      settings.resolutionTier = videoResolutionSelect.value;
    }
    if (videoLanguageSelect.value) {
      settings.language = videoLanguageSelect.selectedOptions[0].textContent;
    }
    if (videoStyleSelect.value) {
      settings.storyStyle = videoStyleSelect.selectedOptions[0].textContent;
    }
    if (musicEnabledToggle.checked && videoMusicTrackSelect.value) {
      settings.musicEnabled = true;
      settings.musicTrack = videoMusicTrackSelect.value;
    }
    return settings;
  }

  // isScriptPaste (Chat-to-Video), when true, tells the backend this exact
  // message is a complete, already-written script the user explicitly
  // flagged via the "Paste Script" toggle — never inferred from the
  // message's length or shape, so an ordinary long chat message is never
  // mistaken for one, and a short script is recognized just as reliably.
  // scriptPasteSettings (only meaningful alongside isScriptPaste) carries
  // whatever Create Video form settings collectScriptPasteFormSettings
  // found already selected.
  async function callAgent(message, onProgress, isScriptPaste, scriptPasteSettings) {
    let data = await postAgentRequest({
      message,
      conversationHistory,
      jobId,
      isScriptPaste: Boolean(isScriptPaste),
      ...(isScriptPaste ? { scriptPasteSettings } : {}),
    });
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

  // Chat-to-Video: the chat box is a textarea (not a single-line input) so
  // a complete, multi-paragraph script + instructions can be pasted in
  // comfortably. Enter still sends the message like a normal chat input;
  // Shift+Enter inserts a newline instead, so a pasted script's own line
  // breaks are never mistaken for "send".
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  // Grows the textarea with its content (up to the CSS max-height, where it
  // scrolls instead) so a longer paste stays fully visible while typing,
  // without needing a separate library.
  function autoGrowInput() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }
  input.addEventListener('input', autoGrowInput);

  // Chat-to-Video: the ONLY signal that a message is a complete pasted
  // script — the user explicitly turns this on right before sending it.
  // It always resets to off after one send (success or failure), so it
  // never silently stays on and flags a later, unrelated message.
  let scriptPasteMode = false;

  function setScriptPasteMode(on) {
    scriptPasteMode = on;
    scriptPasteToggle.classList.toggle('active', on);
    scriptPasteToggle.setAttribute('aria-pressed', String(on));
    scriptPasteHint.hidden = !on;
    input.placeholder = on ? 'Paste your complete script + instructions here…' : 'Type a message…';
  }

  scriptPasteToggle.addEventListener('click', () => setScriptPasteMode(!scriptPasteMode));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    const isScriptPaste = scriptPasteMode;

    addMessage(text, 'user');
    input.value = '';
    autoGrowInput();
    setScriptPasteMode(false);
    input.disabled = true;
    sendBtn.disabled = true;

    let typingBubble = showTypingIndicator();

    try {
      const reply = await callAgent(text, (progressReply) => {
        typingBubble.remove();
        addMessage(progressReply, 'bot');
        typingBubble = showTypingIndicator();
      }, isScriptPaste, isScriptPaste ? collectScriptPasteFormSettings() : undefined);
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
      maybeStartChatToVideoPipeline();
    }
  });

  // Populates the local music-track picker from the same user-maintained
  // library (data/music/manifest.json, via GET /api/video-options) the
  // Agent's getVideoOptions tool uses — this app never bundles, downloads,
  // or generates music, so the list is often empty. The idea-mode (Create
  // Video) music toggle only offers this library, so it stays disabled/off
  // when the library is empty, exactly as before. The Story-to-Video music
  // section ALSO offers uploading a real music file directly (see
  // storyMusicUploadInput below), which never depends on this shared
  // library being populated — so ONLY its "Choose From Library" radio/
  // select is disabled here when the library is empty; the Enable
  // Background Music checkbox itself is never disabled.
  let hasLibraryTracks = false;
  (async () => {
    try {
      const res = await fetch('/api/video-options');
      if (!res.ok) return;
      const options = await res.json();
      const tracks = Array.isArray(options.musicTrackOptions) ? options.musicTrackOptions : [];
      hasLibraryTracks = tracks.length > 0;

      if (hasLibraryTracks) {
        for (const select of [videoMusicTrackSelect, storyMusicTrackSelect]) {
          select.innerHTML = '';
          for (const track of tracks) {
            const optionEl = document.createElement('option');
            optionEl.value = track.value;
            optionEl.textContent = track.label;
            select.appendChild(optionEl);
          }
        }
        videoMusicTrackSelect.disabled = !musicEnabledToggle.checked;
        musicEnabledToggle.disabled = false;
        storyMusicTrackSelect.disabled = !musicSourceLibraryRadio.checked;
        musicSourceLibraryRadio.disabled = false;
      } else {
        musicEnabledToggle.disabled = true;
        musicEnabledToggle.checked = false;
        musicSourceLibraryRadio.disabled = true;
      }
    } catch (error) {
      // No local video-options available (offline dev, etc.) — leave the
      // music controls in their default off/disabled state.
    }
  })();

  musicEnabledToggle.addEventListener('change', () => {
    videoMusicTrackSelect.disabled = !musicEnabledToggle.checked;
  });

  storyMusicEnabledToggle.addEventListener('change', () => {
    storyMusicOptions.hidden = !storyMusicEnabledToggle.checked;
  });

  function updateMusicSourceVisibility() {
    const useLibrary = musicSourceLibraryRadio.checked;
    musicUploadOptions.hidden = useLibrary;
    musicLibraryOptions.hidden = !useLibrary;
    storyMusicTrackSelect.disabled = !useLibrary || !hasLibraryTracks;
  }
  musicSourceUploadRadio.addEventListener('change', updateMusicSourceVisibility);
  musicSourceLibraryRadio.addEventListener('change', updateMusicSourceVisibility);

  let storyMusicFile = null;
  storyMusicUploadInput.addEventListener('change', () => {
    storyMusicFile = storyMusicUploadInput.files && storyMusicUploadInput.files[0] ? storyMusicUploadInput.files[0] : null;
    storyMusicUploadStatus.textContent = storyMusicFile
      ? `Selected: ${storyMusicFile.name} (${(storyMusicFile.size / (1024 * 1024)).toFixed(1)}MB)`
      : '';
  });

  function formatVolumeDb(value) {
    const num = Number(value);
    if (num === 0) return 'Default';
    return num > 0 ? `+${num} dB` : `${num} dB`;
  }
  storyMusicVolumeInput.addEventListener('input', () => {
    storyMusicVolumeValue.textContent = formatVolumeDb(storyMusicVolumeInput.value);
  });
  storyNarrationVolumeInput.addEventListener('input', () => {
    storyNarrationVolumeValue.textContent = formatVolumeDb(storyNarrationVolumeInput.value);
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
      maybeStartChatToVideoPipeline();
    }
  });

  // --- Story to Video ---
  // A separate, chat-free creation flow from the idea-based form above: the
  // user pastes an already-written script and picks settings directly on
  // this page, with no Claude call needed at all (every setting is already
  // explicit form input — see server.js's POST /api/jobs/story-to-video).
  // Reuses the SAME jobId/pollChatToVideoPipeline machinery the idea-based
  // flow and chat-pasted scripts already use, so Progress/Final Review and
  // resumable polling all work identically regardless of which flow
  // created the job.

  function setStoryMode(showStory) {
    modeIdeaBtn.classList.toggle('active', !showStory);
    modeIdeaBtn.setAttribute('aria-selected', String(!showStory));
    modeStoryBtn.classList.toggle('active', showStory);
    modeStoryBtn.setAttribute('aria-selected', String(showStory));
    ideaModePanel.hidden = showStory;
    storyModePanel.hidden = !showStory;
  }

  modeIdeaBtn.addEventListener('click', () => setStoryMode(false));
  modeStoryBtn.addEventListener('click', () => setStoryMode(true));

  storyScriptInput.addEventListener('input', () => {
    const words = storyScriptInput.value.trim().split(/\s+/).filter(Boolean);
    storyScriptWordcount.textContent = `${words.length} word${words.length === 1 ? '' : 's'}`;
  });

  function updateVoiceSourceVisibility() {
    const useUpload = voiceSourceUploadRadio.checked;
    aiVoiceOptions.hidden = useUpload;
    uploadVoiceOptions.hidden = !useUpload;
  }
  voiceSourceAiRadio.addEventListener('change', updateVoiceSourceVisibility);
  voiceSourceUploadRadio.addEventListener('change', updateVoiceSourceVisibility);

  storyVoiceSpeedSelect.addEventListener('change', () => {
    storyVoiceSpeedCustomInput.hidden = storyVoiceSpeedSelect.value !== 'custom';
  });

  storyBackgroundSelect.addEventListener('change', () => {
    storyBackgroundCustomInput.hidden = storyBackgroundSelect.value !== 'custom';
  });

  storyDurationSelect.addEventListener('change', () => {
    storyDurationCustomInput.hidden = storyDurationSelect.value !== 'custom';
  });

  // Array, in the order the browser lists them in the FileList (the order
  // files were selected/added in the OS file picker) — combined into one
  // continuous voice-over on upload (see the upload loop below).
  let storyUploadedFiles = [];
  storyVoiceUploadInput.addEventListener('change', () => {
    storyUploadedFiles = storyVoiceUploadInput.files ? Array.from(storyVoiceUploadInput.files) : [];
    if (storyUploadedFiles.length === 0) {
      storyVoiceUploadStatus.textContent = '';
    } else if (storyUploadedFiles.length === 1) {
      const file = storyUploadedFiles[0];
      storyVoiceUploadStatus.textContent = `Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)}MB)`;
    } else {
      const totalMb = storyUploadedFiles.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024);
      const names = storyUploadedFiles.map((file) => file.name).join(', ');
      storyVoiceUploadStatus.textContent = `Selected ${storyUploadedFiles.length} files (${totalMb.toFixed(1)}MB total): ${names}`;
    }
  });

  function resolveStoryVoiceSpeed() {
    if (storyVoiceSpeedSelect.value === 'custom') {
      const value = Number(storyVoiceSpeedCustomInput.value);
      return Number.isFinite(value) ? value : 1;
    }
    return Number(storyVoiceSpeedSelect.value) || 1;
  }

  function resolveStoryDuration() {
    if (storyDurationSelect.value === 'custom') {
      return storyDurationCustomInput.value.trim();
    }
    return storyDurationSelect.value;
  }

  // Maps a MIME type the browser reports for the selected file to the
  // Content-Type the upload-voiceover route validates against — File.type
  // is usually already one of these, but a couple of common
  // browser/OS-dependent spellings for m4a are normalized here so a real
  // audio file is never rejected just because of which browser picked it.
  function normalizeAudioContentType(file) {
    if (file.type) return file.type;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    return 'application/octet-stream';
  }

  function setStoryCostStatus(text, type) {
    storyCostStatus.textContent = text;
    storyCostStatus.className = 'generate-status' + (type ? ' ' + type : '');
    storyCostStatus.hidden = false;
  }

  function renderCostBreakdown(costEstimate) {
    storyCostBreakdownList.innerHTML = '';
    const rows = [
      ['Voice-over (text-to-speech)', costEstimate.breakdown.voiceover],
      ['Subtitles (transcription)', costEstimate.breakdown.subtitles],
      ['Thumbnail', costEstimate.breakdown.thumbnail],
      ['YouTube package text', costEstimate.breakdown.youtubePackageText],
    ];
    for (const [label, amount] of rows) {
      const li = document.createElement('li');
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      const amountSpan = document.createElement('span');
      amountSpan.textContent = `$${amount.toFixed(4)}`;
      li.appendChild(labelSpan);
      li.appendChild(amountSpan);
      storyCostBreakdownList.appendChild(li);
    }
    storyCostTotal.textContent = `Estimated total: $${costEstimate.totalUsd.toFixed(4)}`;
  }

  // Shows exactly what was selected — never a cost line, since background
  // music is always free (a local file, never a paid API) — so the user can
  // confirm their choice before approving production. Reads the just-
  // uploaded/selected values still held client-side rather than round-
  // tripping the job record for them.
  function addSummaryRow(label, value) {
    const li = document.createElement('li');
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const valueSpan = document.createElement('span');
    valueSpan.textContent = value;
    li.appendChild(labelSpan);
    li.appendChild(valueSpan);
    storySettingsSummaryList.appendChild(li);
  }

  function renderMusicSummary() {
    storySettingsSummaryList.innerHTML = '';
    if (!storyMusicEnabledToggle.checked) {
      addSummaryRow('Background music', 'Off');
      return;
    }
    const usingLibrary = musicSourceLibraryRadio.checked;
    const source = usingLibrary
      ? `Library — ${storyMusicTrackSelect.selectedOptions[0] ? storyMusicTrackSelect.selectedOptions[0].textContent : 'none selected'}`
      : `Uploaded — ${storyMusicFile ? storyMusicFile.name : 'none selected'}`;
    addSummaryRow('Background music', 'On');
    addSummaryRow('Music source', source);
    addSummaryRow('Music volume', formatVolumeDb(storyMusicVolumeInput.value));
    addSummaryRow('Narration volume', formatVolumeDb(storyNarrationVolumeInput.value));
  }

  let storyJobId = null;

  storyReviewCostBtn.addEventListener('click', async () => {
    const script = storyScriptInput.value.trim();
    if (!script) {
      setStoryCostStatus('Please paste your complete script first.', 'error');
      storyCostReview.hidden = false;
      storyCostBreakdownList.innerHTML = '';
      storyCostTotal.textContent = '';
      return;
    }
    const useUpload = voiceSourceUploadRadio.checked;
    if (useUpload && storyUploadedFiles.length === 0) {
      setStoryCostStatus('Please choose an audio file to upload first.', 'error');
      storyCostReview.hidden = false;
      return;
    }
    const musicEnabled = storyMusicEnabledToggle.checked;
    const useMusicUpload = musicEnabled && musicSourceUploadRadio.checked;
    const useMusicLibrary = musicEnabled && musicSourceLibraryRadio.checked;
    if (useMusicUpload && !storyMusicFile) {
      setStoryCostStatus('Please choose a music file to upload first.', 'error');
      storyCostReview.hidden = false;
      return;
    }
    if (useMusicLibrary && !storyMusicTrackSelect.value) {
      setStoryCostStatus('Please choose a music track from the library, or switch to uploading your own file.', 'error');
      storyCostReview.hidden = false;
      return;
    }

    storyReviewCostBtn.disabled = true;
    setStoryCostStatus('Preparing your production plan…', 'loading');
    storyCostReview.hidden = false;

    try {
      const backgroundPreset = storyBackgroundSelect.value !== 'custom' ? storyBackgroundSelect.value : undefined;
      const backgroundColor =
        storyBackgroundSelect.value === 'custom' ? storyBackgroundCustomInput.value.replace('#', '') : undefined;

      const createRes = await fetch('/api/jobs/story-to-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script,
          voiceSource: useUpload ? 'upload' : 'ai',
          voiceStyle: storyVoiceStyleSelect.value,
          voiceSpeed: resolveStoryVoiceSpeed(),
          backgroundPreset,
          backgroundColor,
          textSize: storyTextSizeSelect.value,
          showCaptions: storyShowCaptionsToggle.checked,
          duration: resolveStoryDuration(),
          language: storyLanguageSelect.value,
          voiceVolumeDb: Number(storyNarrationVolumeInput.value) || 0,
          musicVolumeDb: Number(storyMusicVolumeInput.value) || 0,
          musicEnabled,
          musicTrack: useMusicLibrary ? storyMusicTrackSelect.value : undefined,
          generateYoutubePackage: storyYoutubePackageToggle.checked,
        }),
      });
      const createBody = await createRes.json();
      if (!createRes.ok) {
        setStoryCostStatus(createBody.error || 'Could not start this video job.', 'error');
        return;
      }

      storyJobId = createBody.job.id;
      let costEstimate = createBody.costEstimate;
      let warning = null;

      if (useUpload) {
        // Uploaded ONE AT A TIME, in the order selected, and awaited in
        // sequence (never in parallel) so the server always has the right
        // "combined so far" audio to join the next part onto — see
        // POST /api/jobs/:id/upload-voiceover's partIndex/totalParts
        // handling. A single file takes this same path with totalParts=1,
        // identical to the request this route always accepted.
        const totalParts = storyUploadedFiles.length;
        const combinedFilename = storyUploadedFiles.map((file) => file.name).join(', ');
        let uploadBody = null;
        for (let i = 0; i < totalParts; i++) {
          const file = storyUploadedFiles[i];
          setStoryCostStatus(
            totalParts > 1 ? `Uploading your narration audio… (${i + 1} of ${totalParts})` : 'Uploading your narration audio…',
            'loading'
          );
          const contentType = normalizeAudioContentType(file);
          const params = new URLSearchParams({
            filename: i === totalParts - 1 ? combinedFilename : file.name,
            partIndex: String(i + 1),
            totalParts: String(totalParts),
          });
          const uploadRes = await fetch(`/api/jobs/${storyJobId}/upload-voiceover?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body: file,
          });
          uploadBody = await uploadRes.json();
          if (!uploadRes.ok) {
            setStoryCostStatus(uploadBody.error || 'Could not upload that audio file.', 'error');
            return;
          }
        }
        costEstimate = uploadBody.costEstimate;
        if (uploadBody.job.voiceover && uploadBody.job.voiceover.syncWarning) {
          warning = uploadBody.job.voiceover.syncWarning;
        }
      }

      if (useMusicUpload) {
        setStoryCostStatus('Uploading your background music…', 'loading');
        const musicContentType = normalizeAudioContentType(storyMusicFile);
        const musicUploadRes = await fetch(`/api/jobs/${storyJobId}/upload-music`, {
          method: 'POST',
          headers: { 'Content-Type': musicContentType },
          body: storyMusicFile,
        });
        const musicUploadBody = await musicUploadRes.json();
        if (!musicUploadRes.ok) {
          setStoryCostStatus(musicUploadBody.error || 'Could not upload that music file.', 'error');
          return;
        }
      }

      if (warning) {
        setStoryCostStatus(warning, 'error');
      } else {
        storyCostStatus.hidden = true;
      }

      renderCostBreakdown(costEstimate);
      renderMusicSummary();
      storyFormFields.hidden = true;
    } catch (error) {
      setStoryCostStatus('Something went wrong preparing your production plan. Please try again.', 'error');
    } finally {
      storyReviewCostBtn.disabled = false;
    }
  });

  storyCancelReviewBtn.addEventListener('click', () => {
    storyCostReview.hidden = true;
    storyFormFields.hidden = false;
  });

  storyApproveBtn.addEventListener('click', async () => {
    if (!storyJobId) return;
    storyApproveBtn.disabled = true;
    setStoryCostStatus('Starting production…', 'loading');

    try {
      const maxBudgetRaw = storyMaxBudgetInput.value.trim();
      const body = maxBudgetRaw ? { maxBudgetUsd: Number(maxBudgetRaw) } : {};
      const res = await fetch(`/api/jobs/${storyJobId}/approve-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryCostStatus(data.error || 'Could not approve this job.', 'error');
        return;
      }

      jobId = storyJobId;
      storeJobId(jobId);
      setStoryCostStatus('Approved — production is now running automatically. Watch progress on the Progress/Final Review tabs.', 'success');
      renderAllCards(data);
      maybeStartChatToVideoPipeline();
    } catch (error) {
      setStoryCostStatus('Something went wrong starting production. Please try again.', 'error');
    } finally {
      storyApproveBtn.disabled = false;
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

    // Captures the target job id NOW, at schedule time, rather than reading
    // the outer `jobId` when the timer actually fires — Chat-to-Video can
    // switch `jobId` to a brand-new job while this timer is still pending
    // (e.g. the user pastes another script while an earlier job's render is
    // still in progress), and without this a stale timer would wrongly poll
    // the NEW job's assemble-video route instead of the one it was
    // originally scheduled for.
    const targetJobId = jobId;

    simpleStoryPollTimer = setTimeout(async () => {
      simpleStoryPollTimer = null;
      try {
        await fetch(`/api/jobs/${targetJobId}/assemble-video`, { method: 'POST' });
      } catch (error) {
        // Ignored — the job's own real, persisted state (checked on the
        // next poll or the next page load) is the source of truth, not
        // this fire-and-forget continuation call.
      }
      if (targetJobId === jobId) {
        await refreshFinalVideoCard();
      }
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

  // --- Chat-to-Video: fully-automatic post-confirmation pipeline ---
  // Once a job created by pasting a script (job.chatToVideoAutoPipeline)
  // has been confirmed, this drives voice-over -> subtitles -> final video
  // -> thumbnail/YouTube package forward with plain, separate HTTP calls
  // on a timer — mirrors pollSimpleStoryRenderProgress's own reasoning:
  // never loop the conversational agent purely to advance a mechanical
  // sequence with nothing left to reason about, and never hold one HTTP
  // request open for the whole thing. Renders each card directly from the
  // response's own job data (never calling refreshFinalVideoCard, which
  // would also kick off pollSimpleStoryRenderProgress and risk two
  // independent timers both trying to advance the same Simple Story Video
  // render at once) so this is the single driver of progress while it's
  // running. Guarded by chatToVideoPollTimer so a chat-triggered
  // confirmation and a page reload can never start two overlapping
  // loops for the same job. Stops itself once the pipeline reports 'done',
  // 'failed', or 'not_applicable' — nothing further to advance.
  let chatToVideoPollTimer = null;
  const CHAT_TO_VIDEO_POLL_INTERVAL_MS = 4000;

  function renderAllCards(job) {
    renderVoiceoverCard(job);
    renderSubtitlesCard(job);
    renderFinalVideoCard(job);
    renderYoutubePackageCard(job);
  }

  // Budget guard: server.js's continueChatToVideoPipeline pauses production
  // (status 'awaiting_reconfirmation') rather than silently spending past
  // what the user approved, whenever the real narration turns out to cost
  // meaningfully more than the estimate they confirmed — see
  // job.budgetGuard. This shows that pause as a chat message with a real
  // "Continue anyway" button that calls POST /reconfirm-budget directly (no
  // LLM call), then resumes polling — the same "plain REST action, not a
  // new chat turn" design as the rest of this pipeline.
  // lastShownBudgetGuardSignature avoids re-adding the identical message on
  // every subsequent poll/page-load while still paused on the same guard.
  let lastShownBudgetGuardSignature = null;

  function renderBudgetGuardPrompt(job) {
    if (!job || !job.budgetGuard) {
      return;
    }
    const signature = `${job.id}:${job.budgetGuard.reason}`;
    if (signature === lastShownBudgetGuardSignature) {
      return;
    }
    lastShownBudgetGuardSignature = signature;

    const bubble = addMessage(job.budgetGuard.reason, 'bot');
    bubble.appendChild(document.createElement('br'));

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn btn-primary';
    continueBtn.textContent = 'Continue anyway';
    continueBtn.addEventListener('click', async () => {
      continueBtn.disabled = true;
      continueBtn.textContent = 'Continuing…';
      try {
        const res = await fetch(`/api/jobs/${job.id}/reconfirm-budget`, { method: 'POST' });
        if (!res.ok) {
          continueBtn.disabled = false;
          continueBtn.textContent = 'Continue anyway';
          return;
        }
        const updatedJob = await res.json();
        continueBtn.remove();
        addMessage('Continuing production at the updated estimate.', 'bot');
        renderAllCards(updatedJob);
        pollChatToVideoPipeline(updatedJob);
      } catch (error) {
        continueBtn.disabled = false;
        continueBtn.textContent = 'Continue anyway';
      }
    });
    bubble.appendChild(continueBtn);
  }

  function pollChatToVideoPipeline(job) {
    if (!jobId || !job || !job.chatToVideoAutoPipeline || !job.confirmed || chatToVideoPollTimer) {
      return;
    }

    // Captures the target job id now, at schedule time — see
    // pollSimpleStoryRenderProgress's identical reasoning for why reading
    // the outer, mutable `jobId` when the timer fires would be wrong if a
    // new script paste switches to a different job in the meantime.
    const targetJobId = jobId;

    chatToVideoPollTimer = setTimeout(async () => {
      chatToVideoPollTimer = null;
      let result = null;
      try {
        const res = await fetch(`/api/jobs/${targetJobId}/continue-pipeline`, { method: 'POST' });
        result = await res.json();
      } catch (error) {
        // Ignored — the job's own real, persisted state (checked on the
        // next poll or the next page load) is the source of truth, not
        // this fire-and-forget continuation call.
      }

      if (targetJobId !== jobId) {
        return;
      }

      if (result && result.job) {
        renderAllCards(result.job);
      }

      if (result && result.status === 'awaiting_reconfirmation') {
        renderBudgetGuardPrompt(result.job);
        return;
      }

      if (result && (result.status === 'in_progress' || result.status === 'waiting_for_confirmation')) {
        pollChatToVideoPipeline(result.job);
      }
    }, CHAT_TO_VIDEO_POLL_INTERVAL_MS);
  }

  async function maybeStartChatToVideoPipeline() {
    if (!jobId) return;
    pollChatToVideoPipeline(await fetchCurrentJob());
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
  maybeStartChatToVideoPipeline();
})();
