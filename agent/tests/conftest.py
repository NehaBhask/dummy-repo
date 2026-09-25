"""
Fixtures for the assistant tests. They run against the real Postgres and the real booking API (the same ones the site
uses), and start the FastMCP server as a separate process on a free port, so the tools are exercised over HTTP exactly as
the agent uses them. Start the API first: `npm start` in backend/.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest
from langchain_mcp_adapters.client import MultiServerMCPClient

import settings

HERE = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def api_url() -> str:
    try:
        httpx.get(f"{settings.API_URL}/api/health", timeout=3).raise_for_status()
    except Exception:
        pytest.skip(f"booking API not running at {settings.API_URL} (start it with `npm start` in backend/)")
    return settings.API_URL


@pytest.fixture(scope="session")
def mcp_url(api_url) -> str:
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "mcp_server.py"],
        cwd=HERE,
        env={**__import__("os").environ, "MCP_PORT": str(port), "PYTHONUNBUFFERED": "1", "API_URL": api_url},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}/mcp"
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            httpx.get(url, timeout=1)  # any HTTP answer means it is listening
            break
        except httpx.HTTPError:
            time.sleep(0.3)
    else:
        proc.kill()
        pytest.fail("MCP server did not start")
    yield url
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="session")
def users(api_url) -> list[dict]:
    return httpx.get(f"{api_url}/api/personas", timeout=10).json()["personas"]


class Tools:
    """The MCP tools as one traveller sees them (their id is the X-User-Id header, as in the agent)."""

    def __init__(self, url: str, user_id: str | None, turn: str | None = None):
        headers = {}
        if user_id:
            headers["X-User-Id"] = user_id
        if turn:
            headers["X-Turn-Id"] = turn
        self.client = MultiServerMCPClient({"k": {"transport": "streamable_http", "url": url, "headers": headers}})
        self._tools = None

    async def call(self, name: str, **args):
        if self._tools is None:
            self._tools = {t.name: t for t in await self.client.get_tools()}
        out = await self._tools[name].ainvoke(args)
        if isinstance(out, list):
            out = "".join(b.get("text", "") for b in out if isinstance(b, dict))
        try:
            return json.loads(out)
        except (TypeError, ValueError):
            return out

    async def names(self) -> set[str]:
        if self._tools is None:
            self._tools = {t.name: t for t in await self.client.get_tools()}
        return set(self._tools)


@pytest.fixture
def tools_for(mcp_url):
    def make(user_id: str | None, turn: str | None = None) -> Tools:
        return Tools(mcp_url, user_id, turn or uuid.uuid4().hex)

    return make
