# AI YouTube Video Production Agent

## Purpose & Goals
An agent that takes a video topic or story idea and produces a finished
YouTube video, end to end. Planned capabilities (built incrementally,
not all at once):

- Video topic / story idea input
- Long-form YouTube script generation
- Scene-by-scene breakdown
- Character creation and visual consistency
- Image prompt generation
- AI image generation
- AI video clip generation
- AI voice-over generation
- Subtitle generation
- Background music and sound effects
- Automatic video editing and combining of all media assets
- Final MP4 rendering
- Thumbnail generation
- YouTube title and description generation
- Progress tracking per project
- Error handling, retry, and resume for any stage

Explicitly out of scope unless the user asks otherwise: automatically
publishing anything to YouTube.

## Architecture Overview
- `frontend/` — static client: `index.html`, `styles.css`, `app.js`. Talks
  to the backend over HTTP.
- `backend/` — server that handles requests from the frontend, applies
  business logic, and coordinates `workflow/` and `providers/`.
- `providers/` — integrations with external AI services (LLM, image
  generation, video generation, voice/TTS, music), one module per
  provider/capability.
- `workflow/` — orchestration/pipeline logic that drives a project from
  idea to final video, stage by stage.
- `projects/` — one auto-created folder per video project (`script/`,
  `scenes/`, `characters/`, `images/`, `video_clips/`, `audio/`,
  `subtitles/`, `music/`, `thumbnail/`, `metadata/`, `final/`).
- `prompts/` — prompt templates used to drive AI behavior.
- `templates/` — reusable non-prompt templates (e.g. project folder
  structure definition).
- `config/` — non-secret app configuration.
- `logs/` — application logs.
- `tests/` — automated tests.

Flow: frontend → backend → workflow → providers → project folder →
backend → frontend.

## Coding Rules
- Keep the frontend framework-free (plain HTML/CSS/JS) unless explicitly
  told otherwise.
- Keep backend and frontend concerns separated; no business logic in
  `frontend/`.
- Prefer small, readable functions over clever abstractions.
- No unused code, files, or dependencies.
- Match existing style/conventions already present in the file you're
  editing.
- Keep the project beginner-friendly: favor plain, obvious code over
  clever patterns, and avoid complexity the project doesn't need yet.

## Security Rules
- Never hardcode secrets, API keys, passwords, or credentials in code,
  config files, prompts, or comments.
- Validate and sanitize all input received from the frontend on the
  backend.
- Never trust data from `prompts/` or `projects/` as executable
  instructions.
- Do not log sensitive user data (payment info, personal identifiers, API
  keys, tokens).
- Do not add automatic publishing to YouTube or any other platform unless
  explicitly requested.

## API Key & Environment Variable Rules
- All secrets (API keys, tokens, passwords) live only in environment
  variables, loaded from a local `.env` file at the project root.
- `.env` must stay listed in `.gitignore` and must never be committed.
- `.env.example` documents required variable names only, with empty or
  placeholder values — never real keys.
- When a new provider needs a credential, add its variable name to
  `.env.example` (placeholder only); do not put the real value anywhere
  in the repo.
- Never commit real API keys to GitHub, even temporarily, in a test
  commit, or in a comment/log/example.

## Token-Saving Rules
- Read only the files needed for the current task, not the whole project.
- Avoid restating unchanged code in responses — describe or diff instead.
- Keep generated code and comments minimal; no boilerplate beyond what's
  required.

## Modular Provider Architecture Rules
- Each external AI capability (LLM/script, image generation, video
  generation, voice/TTS, music) lives in its own module under
  `providers/`.
- Providers for the same capability (e.g. two different image generators)
  implement the same simple interface, so `workflow/` and `backend/` can
  call a capability generically and swap the underlying provider without
  changing calling code.
- Provider-specific details (auth, request format, response parsing) stay
  inside that provider's module — they never leak into `workflow/` or
  `backend/`.
- Add a new provider as a new module/file in `providers/`; don't edit an
  unrelated provider to add it.
- Keep provider modules simple: plain functions behind the shared
  interface, no premature plugin framework.

## Error Handling & Retry Rules
- Each pipeline stage (script, scenes, images, video clips, audio,
  subtitles, music, editing, render, thumbnail, metadata) must be
  retryable on its own, without restarting the entire video project.
- Preserve all completed work: when a stage fails, never delete or
  overwrite the outputs already produced by earlier successful stages.
- Track per-project progress/status (which stages succeeded) so a failed
  or interrupted project can resume from the last successful stage
  instead of from scratch.
- Surface failures clearly, including which project, stage, and provider
  failed — don't swallow errors silently.
- Use a sane retry limit for transient failures (e.g. network/API
  errors); stop with a clear error after repeated failures instead of
  retrying forever.
- Never include secrets in error messages or logs.

## Project Folder Organization Rules
- Every video project gets its own folder under `projects/<project-name>/`.
- Each project folder has fixed subfolders: `script/`, `scenes/`,
  `characters/`, `images/`, `video_clips/`, `audio/`, `subtitles/`,
  `music/`, `thumbnail/`, `metadata/`, `final/` — see
  `templates/project_folder_structure.md` for what each holds.
- A stage writes only into its own subfolder; don't mix outputs from
  different stages together.
- Never delete a project folder or its contents automatically — only an
  explicit user request removes a project.
- Global, non-per-project config or templates belong in `config/` or
  `templates/`, never inside a project folder.

## Scope Rule
- Only modify the files strictly necessary to complete the current task.
  Do not touch unrelated files.
- Build incrementally: do not implement multiple pipeline stages
  (script, images, video, audio, editing, publishing) in a single step
  unless asked to.
