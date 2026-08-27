"""Defines the production pipeline stages and their status values."""

# Order matters: this is the exact sequence the workflow runs in.
STAGE_DEFINITIONS = [
    ("story_development", "Story Development"),
    ("script_writing", "Script Writing"),
    ("scene_breakdown", "Scene Breakdown"),
    ("character_definition", "Character Definition"),
    ("image_prompt_generation", "Image Prompt Generation"),
    ("image_generation", "Image Generation"),
    ("video_clip_generation", "Video Clip Generation"),
    ("voiceover_generation", "Voice-over Generation"),
    ("subtitle_generation", "Subtitle Generation"),
    ("music_sfx", "Background Music / SFX"),
    ("video_editing", "Video Editing"),
    ("rendering", "Rendering"),
    ("thumbnail_creation", "Thumbnail Creation"),
    ("metadata_generation", "Title & Description Generation"),
    ("final_review", "Final Review"),
]

STATUS_WAITING = "waiting"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_RETRYING = "retrying"


def new_stage_list():
    """Return a fresh list of stage dicts, all set to waiting."""
    return [
        {
            "key": key,
            "label": label,
            "status": STATUS_WAITING,
            "attempts": 0,
            "error": None,
            "started_at": None,
            "completed_at": None,
        }
        for key, label in STAGE_DEFINITIONS
    ]


def find_stage(stages, key):
    for stage in stages:
        if stage["key"] == key:
            return stage
    raise KeyError(f"Unknown stage: {key}")


def first_incomplete_stage(stages):
    """Return the first stage that isn't completed, or None if all are done."""
    for stage in stages:
        if stage["status"] != STATUS_COMPLETED:
            return stage
    return None
