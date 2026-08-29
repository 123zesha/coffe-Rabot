# AI YouTube Video Production Agent

An agent that will take a topic or story idea and produce a finished
YouTube video: script, scene breakdown, characters, images, video clips,
voice-over, subtitles, music, editing, final render, thumbnail, and
title/description — with progress tracking and retry/resume support.

**Status: project structure only.** No AI providers are connected yet, no
API keys are configured, and there is no automatic publishing to YouTube.

## Structure

- `frontend/` — plain HTML/CSS/JS client
- `backend/` — server that coordinates workflow and providers
- `providers/` — integrations with external AI services (LLM, image,
  video, voice, music) — none implemented yet
- `workflow/` — orchestration/pipeline logic for producing a video
- `projects/` — one folder per video project, created automatically (see
  `templates/project_folder_structure.md`)
- `prompts/` — prompt templates used to drive AI behavior
- `templates/` — reusable non-prompt templates
- `config/` — non-secret app configuration
- `logs/` — application logs
- `tests/` — automated tests

## Setup

```
cp .env.example .env
```

Fill in `.env` with your own API keys as providers are added. Never commit
`.env`.
