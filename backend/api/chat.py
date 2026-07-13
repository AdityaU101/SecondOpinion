"""
Chat routes — the in-app patient assistant.

The assistant answers health-literacy questions in plain language. When the
frontend has a completed report, it sends a trimmed context string so answers
can reference the patient's actual findings. Hard rules live in the system
prompt: no diagnosis, no treatment plans, always defer to clinicians.

Completions go through the multi-provider fallback chain (llm.py). If no
provider is configured, a graceful canned response keeps the demo alive.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from llm import chat_completion, llm_available

log = logging.getLogger("clearchart.chat")

router = APIRouter(prefix="/api/v1", tags=["chat"])

_SYSTEM_PROMPT = """You are the ClearChart assistant — a friendly health-literacy helper inside a medical-records app.

Rules you must always follow:
- Explain medical terms, lab values, and report findings in plain, calm English a non-medical reader understands.
- You may give general lifestyle and nutrition information (e.g., foods rich in iron or vitamin D).
- NEVER diagnose, never prescribe or dose medication, never tell the user to start/stop a treatment.
- If something sounds urgent or the user describes symptoms, tell them to contact a doctor or emergency services.
- Keep answers short: 2-5 sentences, no markdown headers. Use simple lists only when genuinely helpful.
- If the question is outside health literacy (coding, politics, etc.), gently steer back to their report and health questions.
- End sensitive answers with a brief reminder that this is educational, not medical advice — but don't repeat it on every message."""

_FALLBACK_REPLY = (
    "I can't reach the AI service right now (no API key configured). "
    "Meanwhile: your report's Findings tab explains each value in plain language, "
    "and the Doctor Questions tab has questions you can bring to your next appointment."
)


class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    report_context: str | None = Field(None, max_length=8000, description="Trimmed summary of the user's current report")


class ChatResponse(BaseModel):
    reply: str


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest):
    if not llm_available():
        return ChatResponse(reply=_FALLBACK_REPLY)

    system = _SYSTEM_PROMPT
    if body.report_context:
        system += f"\n\nThe user's current ClearChart report (context for your answers):\n{body.report_context}"

    messages = [{"role": "system", "content": system}]
    for m in body.history[-10:]:
        messages.append({"role": m.role, "content": m.content})
    messages.append({"role": "user", "content": body.message})

    try:
        response = await chat_completion(
            messages=messages,
            max_tokens=500,
            temperature=0.4,
        )
        reply = (response.choices[0].message.content or "").strip()
        if not reply:
            raise ValueError("empty completion")
        return ChatResponse(reply=reply)
    except Exception as exc:  # noqa: BLE001 — any provider failure degrades gracefully
        log.error("chat completion failed: %s", exc)
        raise HTTPException(status_code=502, detail="The assistant is temporarily unavailable. Please try again.")
