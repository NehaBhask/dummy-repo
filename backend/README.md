# APS-05 backend — booking & inventory service

Node 20+ · Express 5 · `pg` · `decimal.js` · Postgres. A modular monolith:
TTL holds → idempotent confirmation → multi-item saga with compensation → cancellation with
restock, plus availability search, NL search, and a built-in load-test engine that proves
zero oversell.

## Run it

```bash
docker compose up -d                 # repo root: Postgres on :5433 (already loaded with the seed)
cd backend && npm install
npm run migrate                      # additive tables/columns only (data-model/migrations/001_additions.sql), idempotent
npm start                            # http://localhost:3000   (cp ../.env.example .env to configure)
npm test                             # 56 tests (in ../tests/) against the real Postgres — see "Testing"
npm run invariants                   # the correctness queries; exit code 1 if any fail
npm run loadtest -- --requests 500   # race 500 requests at a scarce row; run while `npm start` is up
```

Defaults work with the repo's `docker-compose.yml` (`postgres:postgres@localhost:5433/kognivera`).

## The web app

The React UI lives in `../frontend` and is served by this same server once built, so the whole product is one
command after a one-time build:

```bash
npm run build:web     # installs and builds ../frontend into ../frontend/dist (re-run after UI changes)
npm start             # http://localhost:3000  → the app; /api/* → the API
```

Screens (routed, e.g. `/hotel/:id`, `/hold`, `/confirmation/:id`, `/visualizer`; see `../frontend/README.md`): **Home + Search** (AI bar in English/Hindi + filters), **Hold & pay** (live hold countdowns, add a flight,
confirm & pay, retry-the-same-request, rollback view), **My bookings** (status filters, cancel), **Load test**
(live chart, verdict, database-contention evidence). For UI development run `npm run dev` in `../frontend`
(port 5173, proxies `/api` to :3000). See `../frontend/README.md`.

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

### The distributed idempotency proof (`.github/workflows/distributed-idempotency-test.yml`)

`distributed-load-test.yml` uses a **unique** key per request (proves correct serialization under
contention). This one instead has every runner fire its attempts using the **identical** idempotency key —
the "many genuinely separate machines all retrying the same logical action at once" test, simulating a
flaky network's retries or two devices racing on one action for real, not one script calling twice.
`gh-idempotency-verify.mjs` checks the one thing that matters: across every attempt from every machine,
exactly one `hold_id` was ever returned, and exactly one hold's worth of units was consumed — regardless of
how many hundred attempts raced for it.

```bash
gh workflow run distributed-idempotency-test.yml -f base_url=https://your-url -f runners=5 -f attempts_per_runner=20
```

Verified locally first (see commit): 5 separate processes x 20 attempts each, same key, same target — 100
total attempts, 1 original write, 99 replays, 1 distinct `hold_id`, exactly 1 unit consumed.

### The network-retry idempotency test (`.github/workflows/network-retry-test.yml`)

The two proofs above cover *concurrent* retries (many machines, same key, at once). This one covers the
different, sequential case your design doc names explicitly: a client sends a request, the server fully
processes it, but the **response** never arrives back (dropped connection, flaky mobile data) — so the client,
not knowing whether it worked, retries. `scripts/simulate-network-retry.mjs` approximates the dropped response
with a short client-side abort (a real TCP-level drop needs OS tooling like `tc netem`/toxiproxy, out of scope
here) and honestly reports which sub-case actually happened each run — server had already finished (a true
replay) vs. the abort landed before anything was recorded (retry did the original work) — since real timing
can't be perfectly controlled from a script. Either way, exactly one hold must exist per run, never two.

Needs a room with **at least as many free units as `--runs`** (each run creates its own hold, it isn't racing
for one shared unit) — auto-pick searches a few known-bookable cities for a well-stocked room by default, and
fails clearly instead of running if an explicitly-given `--inventory`/`--runs` combination doesn't fit.

```bash
node scripts/simulate-network-retry.mjs --runs 8 --abort-ms 5                          # local
gh workflow run network-retry-test.yml -f base_url=https://your-url -f runs=8          # via GitHub Actions
```

### The mixed confirm / abandoned-hold scenario (`npm run loadtest:mixed`)

A second load-test scenario, on top of the pure race: a crowd races for one row, a share of the winners **confirm and pay**, and the rest **abandon their hold** and let it expire past its TTL. It then asserts the closing balance and prints PASS/FAIL with the numbers.

```bash
npm start                                   # one terminal (expiry worker on, the default)
npm run loadtest:mixed                      # another; ~35 s (8 s TTL + up to one 30 s sweep)
npm run loadtest:mixed -- --requests 100 --confirm-share 0.3 --ttl 10   # options
```

Asserted for the row: `booked + held + available == total`; booked/held/available also equal the figures derived independently from the individual hold records (`GET /api/holds/:id`), not from the row's own counters; no hold is still `active` past its deadline and `held_units` is back to its baseline (no stock leaked by expired holds); a late confirm on an expired hold is refused; zero oversell was sampled (~20 ms) throughout the run and `/api/invariants` is clean. Exit code 0 = PASS, 1 = FAIL.

Not vacuous: with the expiry sweep switched off (`EXPIRY_WORKER=off` on every server sharing the database) the same run FAILS on "no expired hold still holds stock" (10 holds active past their deadline, stock not returned). It runs on confirm + TTL expiry only; cancellation is used afterwards purely to put the test data back (skip with `--keep`).

### An industry-tool run (k6)

`scripts/k6-loadtest.js` races the same target using [k6](https://k6.io) instead of the built-in engine —
useful as a second, independently-recognisable tool alongside the dashboard/GitHub Actions proof, not a
replacement (k6 fires requests; it doesn't know what "oversell" means for this schema on its own, so the
script wires k6's `teardown()` to hit `/api/invariants` directly, making it a genuinely self-contained check,
not just a request-firer):

Each request is sent as a different user: `setup()` fetches active ids from `GET /api/users/ids` and builds a
`{request number: user id}` dictionary, and every request sets `X-User-Id` from it (`-e SINGLE_USER=true` restores the old
no-header behaviour). The activity feed on the Operations dashboard then shows many distinct users.

```bash
winget install --id GrafanaLabs.k6 -e                    # one-time
k6 run scripts/k6-loadtest.js                             # 200 VUs at an auto-picked scarce row, localhost:3000
k6 run -e BASE_URL=https://your-url -e VUS=500 scripts/k6-loadtest.js
k6 run -e VUS=500 -e BYPASS_SHIELD=false scripts/k6-loadtest.js   # production path (shield stays on)
```

Prints k6's own summary (granted/sold_out counts, latency percentiles) plus 5 `check()`s read straight from
the database afterward — a red ✗ on any of them means a real problem, not just "some requests failed".
Granted holds use a 60 s TTL and self-expire; no manual cleanup needed.

### The distributed proof (`.github/workflows/distributed-load-test.yml`)

Everything above races one server from one machine. `gh-fire.mjs` + `gh-verify.mjs` (run as a GitHub
Actions matrix — see the workflow file) instead race one target from **N separate GitHub-hosted VMs** —
genuinely different machines and network paths, not simulated concurrency — then `gh-verify.mjs` re-checks
`/api/invariants` and the actual row afterward rather than trusting the runners' self-reported counts.

- **Requires a public `base_url`.** GitHub's runners can't reach your laptop's `localhost`; use
  `cloudflared tunnel --url http://localhost:3000` for a quick, free, no-account tunnel (a fresh random
  URL every time it restarts), or a real deployment for anything longer-lived.
- **A tunnel is a dev/demo convenience, not something to rely on for the real presentation.** Free
  quick-tunnels can add their own latency and, under a large burst, occasionally drop a connection — which
  shows up in a run's `error` count, indistinguishable at a glance from an actual bug. If `error` is ever
  non-zero, check whether it's `sold_out`/`success` mislabelled vs. a real transport drop before assuming
  the app is at fault; running against a real deployed URL removes this variable entirely.
- **`bypass_shield` (workflow input, default on) chooses which path is under test.** On (default): every
  request skips the in-memory sold-out shield and hits Postgres' row lock directly — the rigorous proof of
  the *database* guarantee. Off: the production path stays on, including the shield's fast in-memory
  rejections — measured locally, ~2.2× lower latency for the same 500-request race (500/0/0 either way;
  1,676 ms total / 1,292 ms p50 with the shield vs. 3,665 ms / 3,299 ms without). Worth running once each
  way for the demo: same guarantee, two paths, one clearly cheaper.
- **Matrix jobs aren't millisecond-synchronized across machines.** GitHub queues each runner VM
  independently, so there's normal queue jitter (seconds, more under GitHub-wide load) before each one
  picks up its job. Within one runner, `gh-fire.mjs`'s gate pattern still fires a genuine simultaneous
  burst; across runners it's "several independent bursts landing close together," not laser-aligned —
  still meaningfully concurrent, just not literally the same microsecond.
- **`gh-fire.mjs`'s idempotency keys are `<tag>-<padded index>`, padded to stay ≥ 8 chars** (the backend's
  minimum — see `validation.js`). The real workflow's tags are always long enough on their own
  (`ghaction-<run_id>-<attempt>-r<index>`); this only matters if you invoke `gh-fire.mjs` directly with a
  short `--tag` for local testing, where an unpadded low index (e.g. `cmpA-0`, 6 chars) would otherwise
  bounce as a `400 validation_error` — silently dropped from the count instead of a real success/sold_out.

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
- **Postgres function** (`HOLD_IMPL=sql`, `data-model/migrations/002_create_holds_function.sql`): lock, check, insert, update
  in one round trip. No measurable change locally (round trip 1.6 ms); the benefit is for a remote database,
  where the lock is no longer held across network round trips (reasoning, not measured).

To see the service's real latency, measure it where it will run: app and Postgres on Linux in the same
region, with the generator on a separate machine. Numbers from this rig are a lower bound on throughput.

## How each guarantee is met

| Requirement | Mechanism | Where |
|---|---|---|
| No oversell | `SELECT … FOR UPDATE` on every inventory row, then check, then update, atomically (Postgres function `kognivera_create_holds`, or the equivalent Node txn with `HOLD_IMPL=js`); DB `CHECK` as safety net | `holds.js`, `data-model/migrations/002_create_holds_function.sql` |
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

`npm test` runs the suites in `../tests/` (index: `../tests/README.md`) against the real Postgres, because the guarantees under test are Postgres' row locks.
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
- `lock_timeout` (2 s) never fires in practice at the design's pool size (20), because the pool itself bounds how many requests can be waiting on a lock at once. Under genuine system-wide overload — every pooled connection busy, not just one contended row — a request instead waits up to `PG_POOL_CONNECT_TIMEOUT_MS` (30 s) for a free connection; `fromPgError` maps that timeout (a plain client-side error with no SQLSTATE) to the same `503 contention_timeout` + `Retry-After` response, verified live by running a 2-connection pool against 500 concurrent requests: 461 came back `503`, zero came back as a bare `500`.
- Cancellation refunds in full (rate-plan cancellation penalties are not applied).
- Hold expiry is sweep-based every 30 s; a late confirm is still rejected exactly.

## Data notes worth knowing

- Inventory covers **2026-09-01 → 2026-11-29**. The design's "Dec 15–17" example queries return nothing; use dates in that window.
- There is no "Goa" city (it's **Panaji**); the NL parser maps common names (Goa, Bangalore, Delhi, …).
- The expiry worker's first run releases the seed's 115 already-expired `active` holds (their deadlines are in August). Counters stay consistent (`npm run invariants`).
- Flight prices are per seat; flight inventory is one row per fare per departure date.
- Load-test holds are kept as `released` rows (R8) with `loadtest_` keys, which `data-model/tools/validate_postgres.py` already exempts. To reset everything: `python data-model/tools/load_data.py --csv-dir data-model/seed/csv --truncate`.
