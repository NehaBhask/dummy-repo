"""
HTTP front of the assistant. The website's API (Node) calls POST /chat with the signed-in traveller and a snapshot of the
page; this service runs the LangChain agent against the FastMCP tool server and returns the reply.

Run:  python run.py                      (MCP server + this service)
      uvicorn service:app --port 8100     (this service only; MCP server started separately)
"""
from __future__ import annotations

from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import assistant
from settings import GEMINI_MODELS, MCP_URL

app = FastAPI(title="Kognivera assistant")


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class User(BaseModel):
    user_id: str = Field(min_length=3, max_length=64)
    display_name: str = ""
    home_currency: str = "INR"


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    history: list[Turn] = []
    context: dict[str, Any] = {}
    user: User
    lang: Literal["en", "hi"] = "en"


@app.get("/health")
async def health() -> dict:
    mcp_ok = False
    try:
        async with httpx.AsyncClient(timeout=2) as c:
            # any HTTP answer (even 4xx for a bare GET) means the tool server is listening
            await c.get(MCP_URL)
            mcp_ok = True
    except httpx.HTTPError:
        pass
    return {"ok": True, "mcp_reachable": mcp_ok, "models": GEMINI_MODELS}


@app.post("/chat")
async def chat(body: ChatIn) -> dict:
    try:
        out = await assistant.chat(
            body.message,
            [t.model_dump() for t in body.history],
            {**body.context, "lang": body.lang},
            body.user.model_dump(),
        )
    except assistant.AssistantUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return out
