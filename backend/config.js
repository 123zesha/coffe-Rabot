require('dotenv').config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY is not set. Add it to your .env file.');
}

module.exports = { ANTHROPIC_API_KEY };
