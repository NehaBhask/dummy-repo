# Architecture — APS-05 Distributed Booking & Inventory

A booking service that **never oversells under concurrency**: availability search with TTL holds, idempotent
confirmation with payment, multi-item saga with compensation, cancellation with restock, localised currency —
proven by a load test that shows zero oversell.

```
 ┌──────────────┐   /api/*    ┌───────────────────────────────────────────┐   pg (pool, max 20)   ┌──────────────┐
 │  frontend/   │ ──────────► │ backend/  Express 5                       │ ────────────────────► │  PostgreSQL  │
 │ React + Vite │             │  routes → validation (zod) → modules      │                       │  16 (Docker) │
 │ en / हिन्दी   │ ◄────────── │  booking · inventory · payment · loadtest │ ◄──────────────────── │  row locks,  │
 └──────────────┘   JSON      │  workers/expiry (30 s sweep)              │                       │  CHECKs, fn  │
        ▲                     └───────────────┬───────────────────────────┘                       └──────────────┘
        │ served as static files              │ imports
        │ (frontend/dist, same server)        ▼
        │                     ┌───────────────────────────────┐   HTTPS   ┌──────────────────────┐
        └──────────────────── │ ai/  search.js + prompts/     │ ────────► │ Gemini (function     │
                              │ NL → params → the SAME SQL    │           │ calling, 3 models)   │
                              └───────────────────────────────┘           └──────────────────────┘
```

`npm start` in `backend/` is the whole product: it serves the API and the built web app from one process.

## Components

| Folder | Role |
|---|---|
| `frontend/` | React 18 + Vite, Airbnb-style light UI with a dark ops theme. Routed pages: Home (Hotels/Flights + AI search), Results, Stay, Hold & pay (countdown, Card/UPI), Confirmation (retry-same-request, rollback view), My bookings (cancel dialog), **System Visualizer** (simulated or live-backend event source), Load test (live chart + verdict). English/Hindi UI, currency switcher, Demo controls that inject saga failures. |
| `backend/src/` | Express API. `routes.js` (HTTP contract) → `validation.js` (zod, strict) → `modules/` (`booking/holds.js`, `booking/bookings.js`, `inventory/*`, `payment/mock.js`, `loadtest/engine.js`, `invariants.js`) → `db.js` (pool, deadlock-retrying `withTx`, sorted `lockInventory`). `errors.js` = bilingual error catalogue + Postgres/pool error mapping. |
| `ai/` | Natural-language search for hotels and flights. Gemini function-calling fills a `search_hotels` / `search_flights` schema (`prompts/`); the result feeds the **same** grounded SQL search as the form (`POST /api/search/ai`, `kind: "hotels" \| "flights"`). Heuristic + cache fallbacks. |
| `data-model/` | Canonical schema, our additive migrations, seed CSVs, loaders and the conformance validator. See `DATA_MODEL.md`. |
| `tests/` | 66 automated tests (plus 16 Python tests for the assistant) against real Postgres (concurrency races, idempotency, saga, expiry, cancel, HTTP contract, AI parsing). |
| `.github/workflows/` | Three GitHub Actions workflows that fire load from separate machines (see "Proof"). |

## How correctness is achieved

**No overbooking.** Reserving units is one transaction: lock every requested `inventory_calendar` row
(`SELECT … FOR UPDATE`, ascending `inventory_id` so multi-row requests cannot deadlock), evaluate availability on
the *locked* row, insert the hold, bump `held_units`. On the hot path this is a single Postgres function
(`kognivera_create_holds`, `data-model/migrations/002_…`) so the lock is held for microseconds. Which request wins
is decided by Postgres's row-lock queue — the guarantee is *exactly the free units are granted*, not fairness.
The provided `CHECK (booked_units + held_units <= total_units)` is a safety net that must never fire; the
`safety_net_hits` metric is asserted to stay 0 in every load test.

**Idempotency.** Every write carries an `Idempotency-Key`. Holds use `INSERT … ON CONFLICT (idempotency_key) DO
NOTHING` (never check-then-insert), so concurrent retries collapse to one row; a replay returns the original
result (`Idempotent-Replayed: true`). Reusing a key for a *different* request is refused.

**TTL holds.** Browsing holds nothing: items sit in the trip as drafts, and **Reserve** places one request over every row — one transaction, one deadline — so a hotel and a flight in the same trip can never expire at different times. If an item sold out in the meantime the whole request fails and nothing is held. A hold has a server-clamped TTL (5 s – 30 min). Expiry is enforced in three places: at confirm time
(`expires_at` is compared directly, so a late confirm is refused no matter when the sweep runs), by a 30 s
background sweep (`workers/expiry.js`, guarded by `pg_try_advisory_xact_lock` so two instances don't double-process)
that returns capacity to the pool, and by the closing-balance check in the mixed load test.

**Multi-item saga.** `POST /api/bookings` claims the booking, confirms each line in its own transaction (holds →
`confirmed`, `booked_units` up), then captures payment. If any step fails, every already-confirmed line is
compensated in its own retried transaction, and the response names the cause with `rolled_back: true`. Progress is
persisted per step; orchestration is in-process (see limitations).

**Cancellation.** Marks the booking `cancelled`, refunds the payment, restocks `booked_units` — all in one
transaction, idempotent, nothing deleted (R8).

**Localised currency.** Storage is always `DECIMAL(12,2)` + ISO-4217 code; display conversion goes through the dated
`fx_rates` table and never overwrites the original amount.

**AI stays grounded.** The model only fills search parameters; it never sees or invents inventory. Every result is a
real database row with real availability. Order of attempts: cache (pre-seeded demo queries) → Gemini (3 models
tried in turn, 6 s timeout each) → English heuristic parser. The response says which parser answered.

## Proof (how we show it)

| What | Command / file |
|---|---|
| In-app race: N travellers vs the scarcest room, verdict read from the **database** | Load test page · `POST /api/loadtests` · `backend/src/modules/loadtest/engine.js` |
| The same guarantees animated from real data (race, saga rollback, duplicate retry) | System Visualizer → **Live backend** · `frontend/src/viz/live.js` |
| Mixed confirm / abandoned-hold run with a closing-balance assertion (`booked + held + available == total`, no stock leaked by expired holds) | `npm run loadtest:mixed` (in `backend/`) |
| Industry tool | `backend/scripts/k6-loadtest.js` (k6) |
| Genuinely separate machines | `.github/workflows/distributed-load-test.yml` · `distributed-idempotency-test.yml` |
| Idempotency under a dropped response | `backend/scripts/simulate-network-retry.mjs` · `network-retry-test.yml` |
| Data invariants at any moment | `GET /api/invariants` · `npm run invariants` |
| Automated tests | `npm test` (in `backend/`) — 66 tests |

Details and measured numbers: `backend/README.md`.

## API (all under `/api`)

| Method · path | Purpose |
|---|---|
| `GET /health` · `/metrics` · `/invariants` | status · safety-net counter · the correctness proof as queries |
| `GET /cities` · `/currencies` · `/fx` · `/meta` · `/demo-user` | reference data |
| `GET /personas` | the 10 demo travellers for the login screen |
| `GET /ops/summary` · `POST /ops/reset-demo` | operator only: holds, bookings, inventory, invariants, activity feed; undo the demo's own holds/bookings |
| `GET /search/hotels` · `/search/flights` · `POST /search/ai` | availability search (form, and natural language) |
| `GET /holds` | the signed-in traveller's live reservations, described and priced (`?currency=`); the trip page uses it to show holds made anywhere, including by the assistant |
| `POST /chat` | booking assistant: session-checked proxy to the agent service (`agent/`), `503 assistant_unavailable` when it is down |
| `GET /inventory/:id` · `/inventory/contended` | one row's counters · the scarce rows worth racing |
| `POST /holds` · `GET /holds/:id` · `POST /holds/:id/release` | TTL hold (`Idempotency-Key` required) |
| `POST /bookings` · `GET /bookings` · `GET /bookings/:id` · `POST /bookings/:id/cancel` | confirm + pay (saga), list, cancel + restock |
| `POST /loadtests` · `GET /loadtests` · `GET /loadtests/:id` | run and read load tests |

Request/response shapes and status codes: `backend/README.md` (API section).

## Known limitations (stated, not hidden)

- A saga interrupted by a process crash between steps is not auto-resumed (no recovery worker yet); a compensation
  that fails after 3 retries leaves the booking `partially_confirmed`. All progress is persisted, so the fix is a
  sweep over stale `pending` bookings — not built.
- Cancellation refunds in full (rate-plan penalties are not applied).
- Hold expiry returns capacity on a 30 s sweep; correctness never depends on it.
- One Node process is the request front door on a dev laptop; a burst of hundreds of simultaneous *new* TCP
  connections can be refused by the OS before the app sees them. That is a transport ceiling, not an oversell.
- The Gemini API is a network dependency; the cache and heuristic parser keep the demo working when it is down.

## Mock login and sessions

The browser sends `X-User-Id` (a seeded active user id, or `operator`); the server checks it against the users table and it wins over any `user_id` in a request body, so one traveller cannot read or cancel another's holds and bookings. A missing header falls back to the demo user, which keeps k6, CI and the load test working unchanged. The operator has no traveller identity (traveller endpoints return 403) and the ops endpoints require it (401/403). **This is demo identity, not authentication:** no passwords, no tokens. Rejected (sold-out) attempts leave no row, so the activity feed keeps them in an in-memory buffer that resets on server restart.

## One-stop flights

`GET /search/flights` returns the direct `results` plus `connections`: pairs of flights where the second leaves the same airport the first landed at, 60 to 360 minutes later (`MIN_LAYOVER_MIN` / `MAX_LAYOVER_MIN` in `modules/inventory/search.js`), with enough free seats on both legs, cheapest first. It is one SQL self-join over the same `inventory_calendar` rows (no AI, no graph library); `connections=false` skips it, `connections_limit` caps it. Each connection carries `stays` (both legs), which the client sends in ONE `POST /holds`: the existing atomic hold locks both rows in order and gives them one deadline, so a connection can never be half-held or oversold, and the saga compensates both lines like any multi-item booking. `GET /flights/routes` also lists origin/destination pairs reachable with one stop. Limits: one stop only, layover must be at the same airport, and the provided flights carry no time zones, so times are compared as stored.

## Booking assistant (MCP)

```
Browser chat widget ──POST /api/chat {message, history, page context}──▶ Express API   (session check, validation)
                                                                            │  {message, context, user}
                                                                            ▼
                                                        agent/service.py  (FastAPI)
                                                          LangChain agent · Gemini (same model + fallbacks as ai/search.js)
                                                                            │  MultiServerMCPClient, headers: X-User-Id, X-Turn-Id
                                                                            ▼
                                                        agent/mcp_server.py  (FastMCP, streamable HTTP)
                                                          read tools ──▶ Postgres (read-only connection, fixed queries)
                                                          write tools ─▶ booking API  (atomic hold, idempotent booking, saga)
```

- **Why MCP:** the model gets one typed tool catalogue (`list_cities`, `search_hotels`, `get_hotel_rooms`, `search_flights`,
  `get_my_bookings`, `get_booking`, `get_my_active_holds`, `reserve_trip`, `pay_and_confirm`, `release_holds`, `cancel_booking`) that any MCP client
  could use, and the tools have one place to enforce rules.
- **Reads vs writes:** reads are direct SQL (fast, no side effects, database refuses writes on that connection). Writes go through
  the same HTTP endpoints as the website, so the guarantees this project is about (no oversell, idempotency, rollback) hold for chat too.
- **Identity:** the Node API takes the signed-in user from the session and puts it in the MCP request header; tools read the user from
  the header, never from arguments. A body `user_id` is ignored.
- **Consent:** reserve, pay and cancel need `user_confirmed=true`; `pay_and_confirm` is refused when `reserve_trip` succeeded in the same
  turn (`X-Turn-Id`), so payment always follows a separate message. Chat bookings are tagged `channel: agent`.
- **Page context:** the widget sends page, URL parameters, hotel/booking id and a summary of the trip cart with every message; the system
  prompt renders it as plain lines so "this hotel", "my trip" and "here" resolve.
- **Failure:** a busy model falls back to the next one; if the chat service or tool server is down the API answers `503 assistant_unavailable`
  and the rest of the site is unaffected.
- **Limits:** the model can misread or misquote; prices it quotes come from tool results (room-only rate, plus 12% tax at payment); it does not
  see the visible UI beyond the context snapshot; a reservation made in chat appears on the My trip page: the trip cart merges the traveller's live holds from `GET /holds` (polled every 5 s, and immediately after the assistant reserves, pays, releases or cancels), so it shows with its shared countdown and can be paid from either place.
