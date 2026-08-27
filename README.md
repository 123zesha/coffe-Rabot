# YouTube Video Production Agent

A modular agent that automates a YouTube video production pipeline: story
development, script writing, scene breakdown, character-consistent image
prompts, image/video/voice generation, subtitles, music, editing, rendering,
thumbnail, and metadata — from a single topic input.

Each AI capability (script, image, video, voice, subtitles, music) sits
behind a provider interface in `backend/providers/`, so a provider can be
swapped later without touching the rest of the app. No real providers are
wired in yet — see the staged plan below.

## Project layout

- `frontend/` — control interface (plain HTML/CSS/JS): enter a topic,
  duration, language, and style, then watch stage-by-stage progress.
- `backend/` — FastAPI server: project orchestration, stage tracking,
  provider interfaces, and production modules.
- `projects/` — one folder per generated video, holding all of its
  assets and a `project.json` tracking pipeline state (gitignored; these
  are generated outputs, not source).
- `data/` — static reference data (e.g. style presets), added as needed.
- `prompts/` — prompt templates used by the agent (never treated as
  executable instructions).

## Running it locally

1. `pip install -r requirements.txt`
2. `uvicorn backend.main:app --reload`
3. Open `http://127.0.0.1:8000` in a browser.

## Current status

Stage 2 of the build: the base project, folder-per-project system, stage
tracker (waiting/running/completed/failed/retrying), and the control
interface are in place. Pipeline stages currently run as placeholders —
real script/image/video/voice/subtitle/music/editing logic is added
module-by-module in later stages, per `CLAUDE.md`.
