"""App-wide configuration, loaded from environment variables (.env)."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

# Which provider implementation each capability should use.
# Stage 2 ships no real providers yet, so these are placeholders
# for the factory wiring added in later stages.
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "anthropic")
IMAGE_PROVIDER = os.getenv("IMAGE_PROVIDER", "stub")
VIDEO_PROVIDER = os.getenv("VIDEO_PROVIDER", "stub")
VOICE_PROVIDER = os.getenv("VOICE_PROVIDER", "stub")
SUBTITLE_PROVIDER = os.getenv("SUBTITLE_PROVIDER", "stub")
MUSIC_PROVIDER = os.getenv("MUSIC_PROVIDER", "stub")
