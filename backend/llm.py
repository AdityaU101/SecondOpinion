"""
LLM access layer — one client, a chain of providers, automatic fallback.

WHY THIS EXISTS
  Every LLM feature in ClearChart (report synthesis, chat, medication gloss,
  visit-packet note, comparison summary) used to construct its own Groq
  client. Free-tier providers rate-limit aggressively, so a burst of demo
  traffic could 429 the whole app at once. This module gives all call sites a
  single `chat_completion()` that walks an ordered provider chain: if the
  primary is rate-limited or down, the request transparently retries on the
  next provider.

WHY ONE OpenAI-COMPATIBLE CLIENT
  Groq and OpenRouter both speak the OpenAI chat-completions dialect
  (including forced function calling), so a "provider" is nothing more than
  a (base_url, api_key, model) triple handed to the same `openai` client.
  Responses have an identical shape, so call sites parse them the same way
  no matter which provider actually answered.

FAILURE POLICY
  Any exception from a provider moves to the next one (rate limits and
  outages are the target, but a model-specific 400 on one provider can also
  succeed elsewhere, so we don't try to be clever about which errors are
  "retryable"). Only when the WHOLE chain fails does the exception propagate —
  and every caller already catches it and degrades to its deterministic
  fallback, so the product never hard-fails on LLM trouble.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from config import settings

log = logging.getLogger("clearchart.llm")


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str


def provider_chain() -> list[Provider]:
    """Configured providers, in the order they should be tried."""
    chain: list[Provider] = []
    if settings.groq_api_key:
        chain.append(Provider(
            name="groq",
            base_url="https://api.groq.com/openai/v1",
            api_key=settings.groq_api_key,
            model=settings.llm_model,
        ))
    if settings.openrouter_api_key:
        chain.append(Provider(
            name="openrouter",
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.openrouter_api_key,
            model=settings.openrouter_model,
        ))
    return chain


def llm_available() -> bool:
    """True when at least one provider is configured. Callers use this the
    way they used to check `settings.groq_api_key` — to short-circuit into
    their deterministic fallback without a doomed network call."""
    return bool(provider_chain())


async def chat_completion(
    messages: list[dict],
    *,
    max_tokens: int,
    temperature: float,
    tools: list[dict] | None = None,
    tool_choice: dict | None = None,
    providers: list[Provider] | None = None,
):
    """Run a chat completion against the provider chain.

    Tries each provider in order; returns the first successful response
    (OpenAI response object — `response.choices[0].message...`). Raises the
    last provider's exception only if every provider fails.
    """
    from openai import AsyncOpenAI

    chain = providers if providers is not None else provider_chain()
    if not chain:
        raise RuntimeError("No LLM provider configured — set GROQ_API_KEY and/or OPENROUTER_API_KEY.")

    last_exc: Exception | None = None
    for i, p in enumerate(chain):
        try:
            client = AsyncOpenAI(api_key=p.api_key, base_url=p.base_url)
            kwargs: dict = {
                "model": p.model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            if tools:
                kwargs["tools"] = tools
                if tool_choice:
                    kwargs["tool_choice"] = tool_choice
            response = await client.chat.completions.create(**kwargs)
            if i > 0:
                log.warning("LLM request served by fallback provider '%s' (primary unavailable)", p.name)
            return response
        except Exception as exc:  # noqa: BLE001 — see FAILURE POLICY above
            last_exc = exc
            more = i + 1 < len(chain)
            log.warning(
                "LLM provider '%s' failed: %s: %s%s",
                p.name, type(exc).__name__, exc,
                " — falling back to the next provider" if more else " — no providers left",
            )
    raise last_exc  # type: ignore[misc]
