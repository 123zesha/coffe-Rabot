"""Stage: turn the story treatment into a full narration script."""
from backend.core import project_manager
from backend.core.prompts import load_prompt


async def run(project, llm):
    project_dir = project_manager.project_path(project["id"])
    story = (project_dir / "script" / "story.md").read_text()

    prompt = load_prompt("script_prompt.txt", story=story, **project["settings"])
    duration_minutes = project["settings"]["duration_minutes"]
    max_tokens = max(4096, int(duration_minutes * 300))

    script = await llm.generate_text(prompt, max_tokens=max_tokens)
    (project_dir / "script" / "script.md").write_text(script)
