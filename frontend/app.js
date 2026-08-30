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

  let conversationHistory = [];
  let jobId = null;

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
    jobId = data.jobId || jobId;
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
    }
  });
})();
