const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const Anthropic = require('@anthropic-ai/sdk');

async function testConnection() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in .env. Add your key and try again.');
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({ apiKey });

  try {
    await client.models.list({ limit: 1 });
    console.log('Anthropic API connection succeeded.');
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic API connection failed: invalid or missing API key.');
    } else if (error instanceof Anthropic.APIConnectionError) {
      console.error('Anthropic API connection failed: network error.');
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API connection failed: ${error.status} ${error.name}`);
    } else {
      console.error('Anthropic API connection failed: unexpected error.');
    }
    process.exitCode = 1;
  }
}

testConnection();
