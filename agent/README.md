# Booking assistant (agent/)

A chat assistant for the site. It knows which page the traveller is on and can search and **book through conversation**.

```
Chat widget ─▶ Express API  POST /api/chat ─▶ service.py (FastAPI) ─▶ assistant.py (LangChain agent + Gemini)
                (session check)                                            │  MultiServerMCPClient
                                                                            ▼
                                                                    mcp_server.py (FastMCP)
                                                              read tools ─▶ Postgres (read-only)
                                                              write tools ─▶ booking API (holds, payment, cancel)
```

| File | Role |
|---|---|
| `mcp_server.py` | **The one MCP server.** Every tool, typed with Pydantic. Who is asking comes from the `X-User-Id` request header. |
| `queries.py` | The read tools' SQL: fixed, parameterised, on a connection Postgres itself makes read-only. Same availability rule as the API (free = total − booked − held); one-stop connections use the same rule as `backend/src/modules/inventory/search.js` (same airport, layover 1 to 6 h). |
| `rest.py` | How write tools call the booking API (with an `Idempotency-Key`). |
| `assistant.py` | The MCP **client** (`langchain-mcp-adapters` `MultiServerMCPClient`, one per chat request so the traveller id rides in the headers), the LangChain agent, the system prompt (with the page context) and the model fallback chain. |
| `service.py` | FastAPI: `POST /chat`, `GET /health`. Only the Node API calls it. |
| `run.py` | Starts the MCP server (port 8101) and the chat service (port 8100). |
| `tests/` | 16 pytest tests. |

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `list_cities`, `search_hotels`, `get_hotel_rooms` | read | Hotels and rooms with live free counts; sold-out categories are shown as sold out. Each room carries a `stay` object for booking. City names are resolved the way people type them (`Delhi` → New Delhi, `Bangalore` → Bengaluru, airport codes), and an unknown city returns suggestions. |
| `search_flights` | read | Direct and one-stop flights; a one-stop option has two `stays` to hold together. |
| `get_my_bookings`, `get_booking`, `get_my_active_holds` | read | Only the signed-in traveller's own data. |
| `reserve_trip` | write | Holds every item atomically for 10 minutes; nothing is charged. Returns the price if paid now (tax included). |
| `pay_and_confirm` | write | Confirms holds with the demo payment gateway. Refused in the same turn as `reserve_trip`. |
| `release_holds`, `cancel_booking` | write | Give back unpaid holds; cancel and restock. |

## Safety

- **Identity:** the traveller id is an HTTP header on the MCP connection; no tool takes a user id argument, so the model cannot act as anyone else. Another traveller's booking is "not found".
- **Consent:** `reserve_trip`, `pay_and_confirm` and `cancel_booking` need `user_confirmed=true`. The system prompt tells the model to restate what will happen and wait for a yes; the server does not rely on that alone: **payment is refused in the same turn as reserving** (`X-Turn-Id`), so the total is always shown and confirmed in a later message.
- **No free-form SQL:** the model can only call the tools above. Writes cannot go around the booking API (and the read connection cannot write).
- **Same guarantees as the site:** a chat booking uses the atomic hold, idempotent booking and saga; two people racing for the last room get one winner. Bookings made here have `channel = 'agent'`.

## Run

```bash
pip install -r agent/requirements.txt
# the API must be running (npm start in backend/); GEMINI_API_KEY comes from backend/.env
cd backend && npm run agent          # or: python agent/run.py
```

Settings (all optional, in `backend/.env`): `AGENT_URL` (used by the API), `API_URL`, `MCP_PORT`, `AGENT_PORT`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `AGENT_TIMEOUT_S`.

## Test

```bash
cd agent && python -m pytest         # needs the API (npm start) and Postgres; the MCP server is started by the tests
```

Covers: every tool over real HTTP, SQL search vs the site's own search (same hotels, prices and cheapest one-stop), the read-only connection,
traveller isolation (another traveller cannot see or cancel a booking), consent flags, the pay-in-a-later-turn rule, two travellers racing for
the last room, and the agent wiring with a scripted model (tool call, page context in the prompt, failed tool reported, model fallback, tool
server down). The Node side is in `tests/chat.test.js`.

## Limits

The model can misread or misquote; quoted prices come from tool results (room-only rate; 12% tax is added at payment). A reservation made in chat appears on the **My trip** page within a few seconds (the trip page reads the traveller's live holds from `GET /api/holds`), with its countdown, and can be paid from there or in chat. One MCP session is opened per tool call (stateless), which is fine at demo scale.
