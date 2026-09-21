# APS-05 backend — booking & inventory service

Node 20+ · Express 5 · `pg` · `decimal.js` · Postgres. A modular monolith:
TTL holds → idempotent confirmation → multi-item saga with compensation → cancellation with
restock, plus availability search, NL search, and a built-in load-test engine that proves
zero oversell.

## Run it

```bash
docker compose up -d                 # repo root: Postgres on :5433 (already loaded with the seed)
cd backend && npm install
npm run migrate                      # additive tables/columns only (sql/001_additions.sql), idempotent
npm start                            # http://localhost:3000   (cp .env.example .env to configure)
npm test                             # 41 tests against the real Postgres (see "Testing")
npm run invariants                   # the correctness queries; exit code 1 if any fail
npm run loadtest -- --requests 500   # race 500 requests at a scarce row; run while `npm start` is up
```

Defaults work with the repo's `docker-compose.yml` (`postgres:postgres@localhost:5433/kognivera`).

## The proof

`npm run loadtest -- --requests 500 --inventory inv_4ebf56b9` (a real seed row, 3 rooms free), from a
separate process, 500 concurrent HTTP requests:

```
result   3 granted · 497 sold_out · 0 errors    (expected 3 granted)
  PASS  no_oversell                  booked+held <= total, whole DB
  PASS  exactly_free_units_granted   3 of 3
  PASS  no_request_granted_twice     (also run with every request sent 3× on the same key)
  PASS  counters_reconcile           held_units == Σ active holds, checked against the holds table
  PASS  db_check_never_fired         the DB CHECK constraint never had to reject a write
  PASS  no_transport_or_server_errors
```

The verdict reads the database, not the responses. `db_check_never_fired` matters: the provided
`CHECK (booked+held<=total)` would quietly turn an application-level race into "clean" rejections,
so the engine also counts how often it fires and requires **zero** (verified by removing the row lock:
that check fails). Same result at 1,000 concurrent requests.

### Is the load test really concurrent? What it does and doesn't prove

- All N requests are created up front and released at the same instant (`Promise.all` behind a gate). Over
  HTTP they travel on a pool of 100 keep-alive sockets (`LOADTEST_MAX_SOCKETS`), so at most ~100 are on the
  wire at once and the rest wait client-side; the server's 20-connection pool then puts up to 20 transactions
  on the database simultaneously. `--direct` skips HTTP and calls the service 500 times at once.
- **The default run attacks Postgres' row lock directly.** The production sold-out shield
  (`FAST_REJECT`) queues single-row requests in Node *before* the database, which would hide the lock from
  the test (measured: 0 sessions blocked on the lock with the shield on, 19 with it bypassed). So the engine
  sends `X-Bypass-Shield: 1` (honoured only outside `NODE_ENV=production`) and reports
  `peak_db_sessions_blocked_on_row_lock` as evidence that contention reached Postgres. Use `--shield`
  (`bypass_shield:false` via the API) to see production behaviour and its lower latency.
- The row-lock mutation checks: removing `FOR UPDATE` from either implementation makes the 200-way race test
  fail on the `db_check_never_fired` assertion, so the tests would notice a broken lock.
- Not covered: multiple *servers* racing is exercised by `start:cluster` (up to 8 processes, zero oversell),
  but the load-test UI/CLI drives one target server.

### About the latency numbers (read this before tuning)

A 500-request burst that arrives in the *same instant* shows p50 ≈ 0.8 s, total ≈ 1.3 s on the dev rig
(Windows + Docker Desktop). That is mostly the rig, not the service. Measured, same machine:

| what | time for 500 concurrent requests |
|---|---|
| server that does nothing (`GET /api/metrics`, 100 sockets) | 230–460 ms |
| one trivial DB query per request (`GET /api/health`) | 724 ms |
| **`POST /api/holds` (JSON, validation, replay lookup, reservation)** | **~1,270 ms** |

So we are within ~2× of "a server that does one DB query". The database path itself is the shared ceiling:
Postgres does ~5,500 queries/s *inside* the container but only ~2,150/s through Docker Desktop's port
forwarding, while Postgres CPU stays ~14% and the search query runs in 0.6 ms. Throughput at 20 → 50 → 100
pool connections was unchanged.

What each optimisation measured (same 500-race on one hot row, warm server, all `ZERO OVERSELL`):

| config | race | p50 | p99 |
|---|---|---|---|
| original (Node txn, always lock) | 1,395 ms | 848 ms | 1,332 ms |
| reserve in one Postgres function | 1,458 ms | 1,058 ms | 1,340 ms |
| **+ sold-out shield (current default)** | **1,271 ms** | **792 ms** | **1,225 ms** |
| default + **load balancer** (`start:cluster`, 4 workers) | 2,137 ms | 1,472 ms | 2,076 ms |

- **A load balancer does not help here, and hurts the hot-row case.** Verified three ways: hot-row race
  (1 → 2 → 4 → 8 workers: 1.2 s → 1.5 → 1.8 → 3.3 s), a spread-out read workload (249 → 259 → 199 req/s),
  and the shared ceiling above. Every worker funnels through the same Docker→Postgres path, and more
  workers put more sessions on the same row lock. It is still correct (`ZERO OVERSELL` at every size);
  it just isn't faster. `npm run start:cluster` exists for a deployment where Node CPU is the limit and
  Postgres is fast/local (`WEB_CONCURRENCY`, keep workers × `PG_POOL_MAX` under Postgres' 100 connections).
- **Sold-out shield** (`src/modules/inventory/soldout.js`): once a row is found full, this process answers
  "sold out" from memory for `SOLD_OUT_CACHE_MS` (300 ms) and queues single-row attempts per row in memory
  instead of on database locks. It only ever rejects early (a grant still needs the locked reserve in
  Postgres) and is cleared the instant this process frees units. Cost: units freed by *another* process can
  be invisible here for up to 300 ms. Gain on this rig is small (~9%); the point is that a sold-out row now
  costs the database one call instead of one per request, which matters for a shared/remote database.
- **Postgres function** (`HOLD_IMPL=sql`, `sql/002_create_holds_function.sql`): lock, check, insert, update
  in one round trip. No measurable change locally (round trip 1.6 ms); the benefit is for a remote database,
  where the lock is no longer held across network round trips (reasoning, not measured).

To see the service's real latency, measure it where it will run: app and Postgres on Linux in the same
region, with the generator on a separate machine. Numbers from this rig are a lower bound on throughput.

## How each guarantee is met

| Requirement | Mechanism | Where |
|---|---|---|
| No oversell | `SELECT … FOR UPDATE` on every inventory row, then check, then update, atomically (Postgres function `kognivera_create_holds`, or the equivalent Node txn with `HOLD_IMPL=js`); DB `CHECK` as safety net | `holds.js`, `sql/002_create_holds_function.sql` |
| No deadlock | rows always locked in ascending `inventory_id` (`lockInventory`); holds → inventory order everywhere; saga steps are single-row txns | `db.js` |
| Idempotent holds | per-row key `<client key>#<i>`; `INSERT … ON CONFLICT DO NOTHING`; same key + different body → `422 idempotency_conflict` | `holds.js` |
| Idempotent bookings | `INSERT booking(pending) … ON CONFLICT (idempotency_key) DO NOTHING` decides who owns the saga; retries get the stored outcome (`409 request_in_progress` while it runs) | `bookings.js` |
| TTL + release on timeout | `expires_at`; late confirm rejected even before the worker sweeps; worker frees units every 30 s under a Postgres advisory lock | `holds.js`, `workers/expiry.js` |
| Saga + compensation | hold→booked per line (own txn), mock payment outside any txn, finalise; on failure every line is compensated (restock / release), booking `failed`, payment `failed` | `bookings.js` |
| Cancellation restock | one txn; booking row lock makes concurrent double-cancel restock exactly once | `bookings.js` |
| Localised currency | prices/totals converted via `fx_rates` (pivot through INR); `Intl` display honours `minor_unit_exponent`; money is `decimal.js`, 2dp strings | `fx.js`, `money.js` |
| Bilingual errors | `?lang=hi` or `Accept-Language: hi` | `errors.js` |

Tax rule (derived from the seed, all 1,390 confirmed bookings): `total = Σ lines × 1.12`, `tax = Σ lines × 0.12`.

## API

All bodies are JSON. Money is `{amount:"1234.50", currency:"INR", display:"₹1,234.50"}` in search results and
`amount`/`currency` string pairs on bookings. Errors: `{"error":{"code","message","details?"}}`.
No auth: requests without `user_id` act as the demo user (`GET /api/demo-user`).

| | |
|---|---|
| `GET /api/search/hotels` | `city, check_in, nights, rooms, adults, children, max_price, min_stars, breakfast, refundable, currency, sort, limit` → hotels → rooms (with `stay` to pass to `/holds`, live `available_units`, rate-plan `options`) |
| `GET /api/search/flights` | `origin, destination, date, seats, cabin, max_price, currency` |
| `POST /api/search/ai` | `{query, currency?}` English/Hindi → parsed params + results (+ summary with Gemini). `parser` says who answered |
| `POST /api/holds` | **`Idempotency-Key` header required.** `{items:[{inventory_id,units} \| {entity_type,entity_id,for_date,nights,units}], ttl_seconds?}` → `201` (or `200` + `Idempotent-Replayed: true`). `409 sold_out` |
| `GET /api/holds/:id` · `POST /api/holds/:id/release` | hold + `seconds_remaining` (for the countdown) |
| `POST /api/bookings` | **`Idempotency-Key` required.** `{hold_ids \| items:[{hold_id,rate_plan_id?}], currency?, payment:{method}, simulate_failure?}` → `201` confirmed, `200` replay, or on saga failure `409/402` with `error.rolled_back:true` **and the compensated booking** |
| `GET /api/bookings?user_id&status` · `GET /api/bookings/:id` | My Bookings |
| `POST /api/bookings/:id/cancel` | restocks; idempotent |
| `POST /api/loadtests` | `{inventory_id?, concurrent_requests≤1000, units_per_request, duplicate_factor≤5, mode:"api"\|"direct", cleanup, bypass_shield (default true), wait}` → `202` run; poll `GET /api/loadtests/:id` (live counters, latency percentiles, `timeline[]`, then `verdict`, `histogram`). `GET /api/loadtests` lists runs |
| `GET /api/inventory/contended` | scarce rows to race (starter query #1) |
| `GET /api/invariants` · `/api/health` · `/api/metrics` | proof / status |

Demo saga failure: hold a room and a flight, then `POST /api/bookings` with `"simulate_failure":"flight"`
(hotel confirms first, then the flight fails and the hotel is compensated), or hold the flight with
`ttl_seconds: 5`, wait, and confirm (natural `hold_expired`). Fault injection is off when `NODE_ENV=production`.

## Testing

`npm test` runs against the real Postgres, because the guarantees under test are Postgres' row locks.
Fixtures are `inventory_calendar` rows dated 2031+ (seed covers Sep–Nov 2026) and are deleted afterwards;
seed data is never modified by tests. Covered: 200-way and multi-unit races, simultaneous retries, key reuse,
atomic multi-night holds, opposite-order deadlock check, expiry, confirm/replay, all three saga failure modes,
contested holds, cancel (incl. 12 simultaneous cancels), FX/rate plans, HTTP contract, search grounding, the
load-test engine (api/direct/duplicate keys), and NL parsing.

## Decisions that differ from `design_submission.md`

- **No Knex.** Plain SQL migration + `pg`; every query that matters needed raw SQL anyway.
- **Gemini over REST** (`fetch`) instead of `@google/generative-ai`, with an English heuristic fallback. Hindi needs `GEMINI_API_KEY`.
- **Additive schema changes beyond the 3 tables:** `booking_items.hold_id` (exact compensation), a partial index on active holds, and `CHECK (booked_units>=0 AND held_units>=0)` (the provided CHECK can't see a counter going negative).
- **Advisory lock on the expiry worker** (closes the design's "single-instance worker" limitation).
- **Idempotent-hold keys are per row** (`<key>#<i>`) so one request can atomically hold every night of a stay.
- **Saga order:** hotel lines before flights, then `inventory_id`. `partially_confirmed` is used only when compensation itself fails after retries (so it is visible, not silent).
- Locks are taken *before* inserting a hold: `holds.inventory_id` is a FK, and insert-then-lock lets two requests deadlock on `FOR KEY SHARE`→`FOR UPDATE`.

## Known limitations

- Compensation that fails after 3 retries leaves the booking `partially_confirmed` (no recovery worker yet); state is not persisted beyond the booking/line rows.
- `lock_timeout` (2 s) never fires in practice because the pool (max 20) bounds lock waiters; if it did, the request gets `503 contention_timeout`.
- Cancellation refunds in full (rate-plan cancellation penalties are not applied).
- Hold expiry is sweep-based every 30 s; a late confirm is still rejected exactly.

## Data notes worth knowing

- Inventory covers **2026-09-01 → 2026-11-29**. The design's "Dec 15–17" example queries return nothing; use dates in that window.
- There is no "Goa" city (it's **Panaji**); the NL parser maps common names (Goa, Bangalore, Delhi, …).
- The expiry worker's first run releases the seed's 115 already-expired `active` holds (their deadlines are in August). Counters stay consistent (`npm run invariants`).
- Flight prices are per seat; flight inventory is one row per fare per departure date.
- Load-test holds are kept as `released` rows (R8) with `loadtest_` keys, which `validate_postgres.py` already exempts. To reset everything: `python load_data.py --truncate`.
