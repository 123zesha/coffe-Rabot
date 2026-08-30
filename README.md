# AI Agent

Project structure for AI Agent.

- `frontend/` — client code (`index.html`, `styles.css`, `app.js`)
- `backend/` — server code
- `data/` — data files
- `prompts/` — prompt templates

## Setup & Running Locally

1. Copy `.env.example` to `.env` and fill in your own values:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `PORT` — port for the server (defaults to `3000` if unset)
2. Install backend dependencies:
   ```
   cd backend
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open `http://localhost:<PORT>/` in your browser — the backend serves both the frontend and the API.

Note: video job data is stored in `data/jobs.json` as simple local
file-based storage for development/demo purposes (see
`backend/job-store.js`).
