"""Runs a project's stages in order, tracking status and enabling resume.

Stage 2 note: the handlers below are placeholders that just simulate work.
Each one gets replaced with real logic in its dedicated later stage
(script writing in Stage 3, images in Stage 5, etc.) without changing
how the orchestrator itself works.
"""
import asyncio
from datetime import datetime, timezone

from backend.core import project_manager
from backend.core.retry import run_with_retry
from backend.core.stage_tracker import (
    STAGE_DEFINITIONS,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_RETRYING,
    STATUS_RUNNING,
    first_incomplete_stage,
)


async def _placeholder_stage(project):
    """Stub handler: pretends to do work. Replaced stage-by-stage later."""
    await asyncio.sleep(1)


STAGE_HANDLERS = {key: _placeholder_stage for key, _ in STAGE_DEFINITIONS}


def _log_error(project_id, stage_key, message):
    log_path = project_manager.project_path(project_id) / "logs" / f"{stage_key}.log"
    timestamp = datetime.now(timezone.utc).isoformat()
    with open(log_path, "a") as f:
        f.write(f"[{timestamp}] {message}\n")


async def run_project(project_id):
    """Resume-friendly pipeline runner: skips stages already completed."""
    project = project_manager.load_project(project_id)

    while True:
        stage = first_incomplete_stage(project["stages"])
        if stage is None:
            return  # all stages completed

        stage["status"] = STATUS_RUNNING
        stage["started_at"] = datetime.now(timezone.utc).isoformat()
        project_manager.save_project(project)

        def on_retry(attempt, error, stage=stage):
            stage["status"] = STATUS_RETRYING
            stage["attempts"] = attempt
            stage["error"] = str(error)
            project_manager.save_project(project)
            _log_error(project_id, stage["key"], f"attempt {attempt} failed: {error}")

        handler = STAGE_HANDLERS[stage["key"]]
        try:
            await run_with_retry(handler, project, max_attempts=3, on_retry=on_retry)
        except Exception as error:
            stage["status"] = STATUS_FAILED
            stage["error"] = str(error)
            project_manager.save_project(project)
            _log_error(project_id, stage["key"], f"final failure: {error}")
            return  # stop the pipeline; user can retry/resume later

        stage["status"] = STATUS_COMPLETED
        stage["completed_at"] = datetime.now(timezone.utc).isoformat()
        stage["error"] = None
        project_manager.save_project(project)
