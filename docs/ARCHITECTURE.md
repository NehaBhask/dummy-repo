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
| `ai/` | Natural-language search. Gemini function-calling fills a `search_hotels` schema (`prompts/`); the result feeds the **same** grounded SQL search as the form. Heuristic + cache fallbacks. |
| `data-model/` | Canonical schema, our additive migrations, seed CSVs, loaders and the conformance validator. See `DATA_MODEL.md`. |
| `tests/` | 48 automated tests against real Postgres (concurrency races, idempotency, saga, expiry, cancel, HTTP contract, AI parsing). |
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
| Automated tests | `npm test` (in `backend/`) — 48 tests |

Details and measured numbers: `backend/README.md`.

## API (all under `/api`)

| Method · path | Purpose |
|---|---|
| `GET /health` · `/metrics` · `/invariants` | status · safety-net counter · the correctness proof as queries |
| `GET /cities` · `/currencies` · `/fx` · `/meta` · `/demo-user` | reference data |
| `GET /search/hotels` · `/search/flights` · `POST /search/ai` | availability search (form, and natural language) |
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
