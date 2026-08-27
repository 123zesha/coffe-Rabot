"""Stage: expand the user's topic into a short story treatment."""
from backend.core import project_manager
from backend.core.prompts import load_prompt


async def run(project, llm):
    prompt = load_prompt("story_prompt.txt", **project["settings"])
    story = await llm.generate_text(prompt)

    project_dir = project_manager.project_path(project["id"])
    (project_dir / "script" / "story.md").write_text(story)
