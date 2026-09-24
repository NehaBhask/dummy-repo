# Tests

All tests run against the **real Postgres** (the guarantees under test are Postgres row locks, so a mock would
prove nothing). They live here, outside `backend/`, and import the code under test from `../backend/src/` and
`../ai/`.

```bash
docker compose up -d                 # repo root: Postgres on :5433
cd backend && npm run migrate        # our additive migrations (once)
npm test                             # node --test over ../tests/*.test.js — 56 tests, ~15 s
```

Baseline: **56 tests · 52 pass · 4 skip · 0 fail** (all 56 pass with `GEMINI_API_KEY=` blanked). The 4 skips are the offline-fallback AI tests, which skip
themselves when a live `GEMINI_API_KEY` is configured.

Fixtures are `inventory_calendar` rows dated 2031+ (the seed covers Sep–Nov 2026), created per test and cleaned up
afterwards; seed data is never modified.

| File | Tests | What it proves |
|---|---|---|
| `holds.test.js` | 14 | **No oversell:** 200 concurrent requests for the last 3 units → exactly 3 succeed, 197 sold out. Multi-unit requests never overshoot. **Idempotency:** 25 simultaneous retries of one key → one hold; a retry of the request that took the last unit is a replay, not `sold_out`; key reuse for a different request is refused. Multi-night holds are atomic, and a trip held in one request (hotel + flight) shares **one deadline**; opposite-order multi-row holds don't deadlock. Release, **TTL expiry** by the worker, restock, and the sold-out memory never blocking a real free-up. |
| `bookings.test.js` | 15 | Hold → booking, payment captured, tax rule. **Idempotent confirm** (20 simultaneous retries → one booking). **Multi-item saga:** expired flight hold, injected flight failure, declined payment — each compensates every confirmed line; a failed booking replays as failed. Two bookings racing for one hold → exactly one wins. **Cancel + restock** (12 simultaneous cancels restock once; nothing deleted). Localised currency at the FX rate; rate-plan price deltas; 60 travellers hold-then-book the last 3 units → exactly 3 bookings. |
| `api.test.js` | 9 | The HTTP contract (status codes, headers, `Idempotent-Replayed`), Hindi saga-failure message, field-level 400s, search only returns genuinely available rooms. **Load-test engine:** 300 concurrent HTTP requests for the last 3 units → exactly 3 and a passing verdict; every request sent 3× with the same key never double-books; final whole-database invariant check. |
| `session.test.js` | 6 | Personas, invalid session, isolation/impersonation refused, two users racing for the last unit (one 201, one 409, loser in the ops feed), operator-only ops endpoints, reset demo leaves seed data untouched. |
| `ai.test.js` | 8 | Heuristic parser (demo query, aliases, no invented values), AI results are grounded in real rows and logged, Hindi without a key is a clear `ai_unavailable`, unknown/no-inventory cities ask or explain rather than guess. **Flights:** the parser reads from/to roles, aliases and dates, real routes return grounded flights, and a missing origin asks (listing real origins) instead of guessing. |
| `errors.test.js` | 4 | Pool timeout / unreachable database map to a clean `503 contention_timeout`, not a 500; existing SQLSTATE mappings unaffected. |
| `helpers.js` | — | Fixture creation and cleanup shared by the suites. |
| `load_test.py` | — | The original Python load generator (psycopg, direct to the database). Kept for comparison; the Node engine is the primary one. |

## The hard-proof and end-to-end proofs (not run by `npm test`)

These need a running server, and some need k6 or GitHub Actions, so they are scripts rather than unit tests. All
of them end by reading the **database**, never trusting the client's own counts.

| Proof | Run |
|---|---|
| CLI race against the scarcest room | `npm run loadtest` (in `backend/`) |
| **Mixed confirm / abandoned-hold + closing balance** | `npm run loadtest:mixed` (in `backend/`) |
| k6 | `k6 run scripts/k6-loadtest.js` (in `backend/`) |
| Idempotency after a dropped response | `node scripts/simulate-network-retry.mjs` (in `backend/`) |
| From separate machines (GitHub Actions matrix) | `.github/workflows/distributed-load-test.yml`, `distributed-idempotency-test.yml`, `network-retry-test.yml` |
| Data invariants right now | `npm run invariants` · `GET /api/invariants` |
| Schema conformance | `python data-model/tools/validate_postgres.py …` |

Their options and measured results are in `backend/README.md`.
