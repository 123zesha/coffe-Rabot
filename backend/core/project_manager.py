"""Creates and persists project folders + project.json state."""
import json
import re
import uuid
from datetime import datetime, timezone

from backend.config import PROJECTS_DIR
from backend.core.stage_tracker import new_stage_list

ASSET_SUBFOLDERS = [
    "script",
    "scenes",
    "characters",
    "prompts",
    "images",
    "video_clips",
    "audio",
    "subtitles",
    "music",
    "thumbnail",
    "metadata",
    "final",
    "logs",
]


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "untitled"


def create_project(topic, duration_minutes, language, style):
    """Create a new project folder + project.json and return the project dict."""
    project_id = f"{slugify(topic)}-{uuid.uuid4().hex[:6]}"
    project_dir = PROJECTS_DIR / project_id

    for subfolder in ASSET_SUBFOLDERS:
        (project_dir / subfolder).mkdir(parents=True, exist_ok=True)

    project = {
        "id": project_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "settings": {
            "topic": topic,
            "duration_minutes": duration_minutes,
            "language": language,
            "style": style,
        },
        "stages": new_stage_list(),
    }
    save_project(project)
    return project


def project_path(project_id):
    return PROJECTS_DIR / project_id


def project_json_path(project_id):
    return project_path(project_id) / "project.json"


def save_project(project):
    path = project_json_path(project["id"])
    path.write_text(json.dumps(project, indent=2))


def load_project(project_id):
    path = project_json_path(project_id)
    if not path.exists():
        raise FileNotFoundError(f"No project found with id '{project_id}'")
    return json.loads(path.read_text())


def list_projects():
    if not PROJECTS_DIR.exists():
        return []
    projects = []
    for entry in sorted(PROJECTS_DIR.iterdir()):
        candidate = entry / "project.json"
        if candidate.exists():
            projects.append(json.loads(candidate.read_text()))
    return projects
