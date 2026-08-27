"""LLM provider backed by the Claude API (Anthropic)."""
from typing import Optional

import anthropic

from backend.providers.base.llm_provider import LLMProvider

MODEL = "claude-opus-5"


class AnthropicLLMProvider(LLMProvider):
    def __init__(self):
        # Reads ANTHROPIC_API_KEY from the environment; never hardcode the key.
        self._client = anthropic.AsyncAnthropic()

    async def generate_text(self, prompt: str, system: Optional[str] = None, max_tokens: int = 4096) -> str:
        kwargs = {"system": system} if system else {}
        response = await self._client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        return "".join(block.text for block in response.content if block.type == "text")
