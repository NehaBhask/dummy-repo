"""Start the whole assistant: the FastMCP tool server, then the agent's HTTP service.

    python run.py

Ctrl+C stops both. (In production they would be two services; for the demo one command is enough.)
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from settings import AGENT_HOST, AGENT_PORT, MCP_HOST, MCP_PORT

HERE = Path(__file__).resolve().parent


def in_use(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def main() -> int:
    busy = [(name, port) for name, host, port in (("MCP tool server", MCP_HOST, MCP_PORT), ("chat service", AGENT_HOST, AGENT_PORT)) if in_use(host, port)]
    if busy:
        for name, port in busy:
            print(f"assistant: port {port} ({name}) is already in use. Is the assistant already running? Stop that copy first, or set MCP_PORT / AGENT_PORT.")
        print("           Windows: netstat -ano | findstr :%d   then   taskkill /PID <pid> /F" % busy[0][1])
        return 1

    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    mcp = subprocess.Popen([sys.executable, "mcp_server.py"], cwd=HERE, env=env)
    time.sleep(1.5)
    api = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "service:app", "--host", AGENT_HOST, "--port", str(AGENT_PORT), "--log-level", "warning"],
        cwd=HERE, env=env,
    )
    print(f"assistant: MCP tools on http://{MCP_HOST}:{MCP_PORT}/mcp, chat service on http://{AGENT_HOST}:{AGENT_PORT}")

    def stop(*_):
        for p in (api, mcp):
            if p.poll() is None:
                p.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        while api.poll() is None and mcp.poll() is None:
            time.sleep(0.5)
    finally:
        stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
