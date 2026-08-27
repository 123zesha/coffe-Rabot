"""Loads prompt templates from the top-level prompts/ directory."""
from backend.config import BASE_DIR

PROMPTS_DIR = BASE_DIR / "prompts"


def load_prompt(filename, **variables):
    """Read a template from prompts/ and fill in {placeholders} with variables.

    Variables are inserted as literal text, never as instructions the
    template itself can override.
    """
    template = (PROMPTS_DIR / filename).read_text()
    return template.format(**variables)
