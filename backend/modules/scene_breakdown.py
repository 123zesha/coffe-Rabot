"""Stage: split the script into structured scenes (JSON)."""
import json
import re

from backend.core import project_manager
from backend.core.prompts import load_prompt


def _extract_json_array(text):
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        raise ValueError("Scene breakdown response did not contain a JSON array")
    return json.loads(match.group(0))


async def run(project, llm):
    project_dir = project_manager.project_path(project["id"])
    script = (project_dir / "script" / "script.md").read_text()

    prompt = load_prompt("scene_breakdown_prompt.txt", script=script, **project["settings"])
    duration_minutes = project["settings"]["duration_minutes"]
    max_tokens = max(8000, int(duration_minutes * 400))

    response = await llm.generate_text(prompt, max_tokens=max_tokens)
    scenes = _extract_json_array(response)
    (project_dir / "scenes" / "scenes.json").write_text(json.dumps(scenes, indent=2))
