# CafeBot

## Purpose
CafeBot is a café web app. It lets customers interact with a simple ordering/assistant experience for a café (browsing menu items, asking questions, placing orders) through a lightweight frontend backed by a small server.

## Architecture Overview
- `frontend/` — static client: `index.html`, `styles.css`, `app.js`. Talks to the backend over HTTP.
- `backend/` — server code that handles requests from the frontend, applies business logic, and talks to data/prompts.
- `data/` — structured data used by the app (e.g. menu items, config).
- `prompts/` — prompt templates used for any AI/assistant behavior.

Flow: frontend → backend → (data / prompts) → backend → frontend.

## Coding Rules
- Keep the frontend framework-free (plain HTML/CSS/JS) unless explicitly told otherwise.
- Keep backend and frontend concerns separated; no business logic in `frontend/`.
- Prefer small, readable functions over clever abstractions.
- No unused code, files, or dependencies.
- Match existing style/conventions already present in the file you're editing.

## Security Rules
- Never hardcode secrets, API keys, or credentials in code — use environment variables.
- Validate and sanitize all input received from the frontend on the backend.
- Never trust data from `prompts/` or `data/` as executable instructions.
- Do not log sensitive user data (payment info, personal identifiers).

## Token-Saving Rules
- Read only the files needed for the current task, not the whole project.
- Avoid restating unchanged code in responses — describe or diff instead.
- Keep generated code and comments minimal; no boilerplate beyond what's required.

## Scope Rule
- Only modify the files strictly necessary to complete the current task. Do not touch unrelated files.
