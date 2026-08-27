"""Abstract interface every LLM provider implementation must follow."""
from abc import ABC, abstractmethod
from typing import Optional


class LLMProvider(ABC):
    @abstractmethod
    async def generate_text(self, prompt: str, system: Optional[str] = None, max_tokens: int = 4096) -> str:
        """Generate text from a prompt. Must return the plain response text."""
        raise NotImplementedError
