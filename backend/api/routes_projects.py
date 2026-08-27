"""HTTP routes for creating, running, and checking on video projects."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core import project_manager
from backend.core.workflow import run_project

router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=500)
    duration_minutes: float = Field(..., gt=0, le=60)
    language: str = Field(..., min_length=1, max_length=50)
    style: str = Field(..., min_length=1, max_length=50)


@router.post("")
async def create_project(request: CreateProjectRequest):
    project = project_manager.create_project(
        topic=request.topic.strip(),
        duration_minutes=request.duration_minutes,
        language=request.language.strip(),
        style=request.style.strip(),
    )
    asyncio.create_task(run_project(project["id"]))
    return project


@router.get("")
async def list_projects():
    return project_manager.list_projects()


@router.get("/{project_id}")
async def get_project(project_id: str):
    try:
        return project_manager.load_project(project_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error))


@router.post("/{project_id}/resume")
async def resume_project(project_id: str):
    try:
        project_manager.load_project(project_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error))
    asyncio.create_task(run_project(project_id))
    return {"status": "resumed"}
