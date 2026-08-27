"""Picks the concrete provider implementation for each capability, based on config.

To add a new LLM provider later: implement LLMProvider in providers/llm/,
add a branch here, and set LLM_PROVIDER in .env. Nothing else changes.
"""
from backend.config import LLM_PROVIDER


def get_llm_provider():
    if LLM_PROVIDER == "anthropic":
        from backend.providers.llm.anthropic_llm import AnthropicLLMProvider
        return AnthropicLLMProvider()
    raise ValueError(f"Unknown LLM_PROVIDER '{LLM_PROVIDER}'. Set LLM_PROVIDER=anthropic in .env.")
