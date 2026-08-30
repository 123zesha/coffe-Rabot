(function () {
  const ERROR_REPLY = "Sorry, I couldn't reach the AI Agent. Please check your connection and try again.";

  const toggleBtn = document.getElementById('chat-toggle');
  const windowEl = document.getElementById('chat-window');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = form.querySelector('.chat-send');
  const messages = document.getElementById('chat-messages');

  let conversationHistory = [];

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
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationHistory }),
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();

      typingBubble.remove();
      addMessage(data.reply, 'bot');
      conversationHistory = Array.isArray(data.conversationHistory)
        ? data.conversationHistory
        : conversationHistory;
    } catch (error) {
      typingBubble.remove();
      addMessage(ERROR_REPLY, 'bot');
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
})();
