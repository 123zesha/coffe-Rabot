"""Retry helper with exponential backoff for transient stage failures."""
import asyncio


async def run_with_retry(func, *args, max_attempts=3, base_delay_seconds=2, on_retry=None):
    """Call async `func(*args)`, retrying on exception with exponential backoff.

    `on_retry(attempt, error)` is called before each wait, so callers can
    record a "retrying" status. Returns the function's result on success,
    or raises the last exception once max_attempts is exhausted.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return await func(*args)
        except Exception as error:
            if attempt >= max_attempts:
                raise
            if on_retry:
                on_retry(attempt, error)
            await asyncio.sleep(base_delay_seconds * (2 ** (attempt - 1)))
