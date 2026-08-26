(function () {
  const MOCK_REPLY = "Hi! I'm CafeBot. My AI brain isn't connected yet.";

  const toggleBtn = document.getElementById('cafebot-toggle');
  const windowEl = document.getElementById('cafebot-window');
  const closeBtn = document.getElementById('cafebot-close');
  const form = document.getElementById('cafebot-form');
  const input = document.getElementById('cafebot-input');
  const messages = document.getElementById('cafebot-messages');

  function addMessage(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = 'cafebot-bubble ' + sender;
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
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

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, 'user');
    input.value = '';

    setTimeout(() => addMessage(MOCK_REPLY, 'bot'), 400);
  });
})();
