const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'frontend')));

app.post('/api/agent', (req, res) => {
  const { message, conversationHistory } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  res.json({
    reply: "Hi! I'm your YouTube AI Production Agent. My AI brain isn't connected yet.",
    conversationHistory: conversationHistory || [],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
