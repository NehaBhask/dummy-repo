"""The booking API as the MCP write tools use it. Writes go through the same endpoints the website uses
(atomic hold, idempotent booking, saga), so a chat booking gets every guarantee a click booking gets."""
from __future__ import annotations

import uuid

import httpx

from settings import API_URL


def _error(res: httpx.Response) -> dict:
    body = {}
    try:
        body = res.json()
    except Exception:
        pass
    err = body.get("error") or {}
    return {
        "ok": False,
        "status": res.status_code,
        "error_code": err.get("code", "http_error"),
        "message": err.get("message") or res.text[:200],
        "details": err.get("details"),
    }


def call(method: str, path: str, user_id: str, *, json: dict | None = None, idempotent: bool = False) -> dict:
    headers = {"X-User-Id": user_id}
    if idempotent:
        headers["Idempotency-Key"] = f"agent-{uuid.uuid4().hex}"
    try:
        res = httpx.request(method, f"{API_URL}{path}", headers=headers, json=json, timeout=30)
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "status": 0,
            "error_code": "api_unreachable",
            "message": f"The booking API did not answer: {exc.__class__.__name__}",
        }
    if res.status_code >= 400:
        return _error(res)
    return {"ok": True, "status": res.status_code, "body": res.json()}
