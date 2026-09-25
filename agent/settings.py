"""Configuration for the assistant, read from the environment (and backend/.env, the same file the API uses)."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "backend" / ".env")
load_dotenv(ROOT / ".env")


def _csv(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/kognivera")

# The booking API the write tools call (holds, payment, cancel). Reads go straight to Postgres.
API_URL = os.getenv("API_URL", "http://127.0.0.1:3000").rstrip("/")

# Where the FastMCP server listens, and where the agent's MCP client connects.
MCP_HOST = os.getenv("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.getenv("MCP_PORT", "8101"))
MCP_URL = os.getenv("MCP_URL", f"http://{MCP_HOST}:{MCP_PORT}/mcp")

AGENT_HOST = os.getenv("AGENT_HOST", "127.0.0.1")
AGENT_PORT = int(os.getenv("AGENT_PORT", "8100"))

# The same Gemini model the rest of the app uses (ai/search.js): first is primary, the rest are fallbacks.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODELS = [m for m in [os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"), *_csv(os.getenv("GEMINI_FALLBACK_MODELS", "gemini-flash-lite-latest,gemini-3.1-flash-lite"))] if m]

AGENT_TIMEOUT_S = float(os.getenv("AGENT_TIMEOUT_S", "45"))
AGENT_MAX_STEPS = int(os.getenv("AGENT_MAX_STEPS", "12"))
