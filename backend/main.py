"""FastAPI entrypoint: serves the frontend and the project API."""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.api.routes_projects import router as projects_router
from backend.config import BASE_DIR

app = FastAPI(title="YouTube Video Production Agent")

app.include_router(projects_router)
app.mount("/", StaticFiles(directory=BASE_DIR / "frontend", html=True), name="frontend")
