# Data model — APS-05 Distributed Booking & Inventory

The canonical APS-05 model (`schema.sql`, seeded from `seed/csv/`) is the source of truth. **We keep every
canonical table and column name.** Everything we added is additive (rule R1) and listed below.

```
data-model/
├── schema.sql             canonical Postgres DDL, unchanged (schema.sqlite.sql = SQLite twin)
├── enums.json             canonical enum values (R5)
├── migrations/            OUR additions, additive + idempotent, applied by `npm run migrate`
│   ├── 001_additions.sql       3 new tables, 1 new column, 1 index, 1 CHECK
│   ├── 002_create_holds_function.sql   kognivera_create_holds() — the atomic reserve (a function, no new table)
│   ├── 003_load_test_snapshot.sql      1 new column
│   └── 004_hub_flights.sql             demo flights (rows only): daily schedule via New Delhi and Mumbai for one-stop itineraries
├── seed/csv/              the 20 canonical CSVs (41,855 rows) — what the demo runs on
├── seed/queries/          starter queries;  seed/APS-05.db = SQLite copy of the same data
└── tools/                 load_data.py · apply_schema.py · validate_postgres.py · validate_conformance.py
```

## Canonical tables we use

Tables the backend reads or writes (counted from the SQL in `backend/src/` and `ai/`):

| Table | How APS-05 uses it |
|---|---|
| `inventory_calendar` | **The contended resource.** `booked_units + held_units <= total_units` is defended by a row lock (`SELECT … FOR UPDATE`) inside one transaction, with the DB `CHECK` as a safety net that must never fire. |
| `holds` | TTL reservations. `idempotency_key` is UNIQUE — `INSERT … ON CONFLICT DO NOTHING`. Expired/released rows are kept (R8). |
| `bookings` / `booking_items` / `payments` | Multi-item saga: one header, one line per item, one mock payment. A line can be `compensated` while the rest roll back; cancellation marks `cancelled` and restocks. |
| `hotel_room_types`, `hotels`, `hotel_rate_plans`, `cities` | Availability search (a room type is the bookable unit). |
| `flights`, `flight_fares`, `airports`, `airlines` | Flight search; `flight_fares` is the second `entity_type` in `inventory_calendar`. |
| `users` | The demo traveller (no auth in scope). |
| `currencies`, `fx_rates` | Localised currency. Amounts stay `DECIMAL(12,2)` + ISO-4217 code; conversion goes through the dated `fx_rates` table and never overwrites the original amount. |

Present in the schema and seeded, but not used by APS-05 code: `itineraries`, `trips`, `languages`, `countries`.
They are kept intact because other statements join through them.

## What we added (all additive — R1)

| Addition | Type | Why |
|---|---|---|
| `load_test_runs` | new table | One row per load-test run: config, counts, latency percentiles, the full verdict JSON, and `oversold` (must be `false`). |
| `load_test_results` | new table | One row per request attempt in a run (status, latency, HTTP status, hold id). |
| `search_logs` | new table | Every AI search: raw query, BCP-47 `language` (R6), `parser` (gemini / heuristic / cache), parsed params, latency. |
| `booking_items.hold_id` | new column + index | Ties a booking line to the exact hold it consumed, so saga compensation is exact even when two lines of one booking hit the same inventory row. |
| `idx_holds_active_expiry` | new partial index | The expiry sweep scans only live holds by deadline. |
| `inventory_calendar_nonneg_units` | new CHECK | The canonical `CHECK` cannot see a counter going negative, which would hide an oversell elsewhere. This adds `booked_units >= 0 AND held_units >= 0`. |
| `load_test_runs.snapshot` | new column | Lets any server process answer `GET /api/loadtests/:id` when the API runs as several workers. |
| `kognivera_create_holds(...)` | new function | Lock → check → insert → update in one database call, so the row lock is held for microseconds. Same semantics as the Node fallback (`HOLD_IMPL=js`) and covered by the same tests. |

No canonical column was renamed, dropped, retyped or repurposed.

## Boundary rules — enforced in code, not just described

| Rule | Where it is enforced | Test |
|---|---|---|
| **No overbooking** under concurrency | `kognivera_create_holds()` (`migrations/002_…sql`) / `backend/src/modules/booking/holds.js` — rows locked in ascending `inventory_id` order (no deadlocks), availability evaluated on the locked row. DB `CHECK` behind it. | `tests/holds.test.js` (200 concurrent for the last 3 units), `tests/api.test.js` (300 over HTTP), `tests/bookings.test.js` (60 hold-then-book), `backend/scripts/*loadtest*` |
| **Idempotent booking/hold** | UNIQUE `idempotency_key` + `ON CONFLICT DO NOTHING` (never check-then-insert); a replay returns the original result. | `tests/holds.test.js` (25 simultaneous retries → 1 hold), `tests/bookings.test.js` (20 simultaneous retries → 1 booking) |
| **Hold TTL bounds** 5 s – 1800 s | `backend/src/validation.js` (`ttl_seconds`), and clamped again server-side in `holds.js` (`config.holdTtlMinSeconds/MaxSeconds`). A late confirm is rejected by comparing `expires_at` at confirm time, independent of the 30 s sweep. | `tests/holds.test.js` (expiry), `tests/bookings.test.js` (expired hold → saga rolls back) |
| **Quantity bounds** 1–20 units per line, 1–60 lines per request | `backend/src/validation.js` (zod, `.strict()` — unknown fields rejected) | `tests/api.test.js` (bad input → 400 with field details) |
| **Currency = ISO-4217** | `backend/src/validation.js` (`^[A-Z]{3}$`), `backend/src/fx.js` | `tests/bookings.test.js` (localised currency), `tests/api.test.js` |
| **R2** opaque prefixed ids | `backend/src/ids.js` (`hld_`, `bkg_`, `bit_`, `pay_`, `inv_`, … — never parsed for meaning) | — |
| **R3** money never a float | `backend/src/money.js` (decimal.js, 2 dp) + `pg` returns `NUMERIC` as string | `tests/bookings.test.js` |
| **R6** language is BCP-47 | `search_logs.language` (`en-IN`, `hi`); API errors localised `en` / `hi` (`backend/src/errors.js`) | `tests/api.test.js` (Hindi saga-failure message), `tests/ai.test.js` |
| **R8** nothing hard-deleted | Every state change sets `status` + `updated_at`; expiry → `expired`, release → `released`, cancel → `cancelled`, saga rollback → `compensated`. Load-test holds are released, never deleted. | `tests/bookings.test.js` |
| **Data invariants** | `backend/src/modules/invariants.js` — `oversold`, `negative`, `held_drift` (held ≠ Σ active holds), `booked_drift` (booked ≠ Σ confirmed items). Exposed at `GET /api/invariants`. | asserted in `tests/holds.test.js`, `tests/bookings.test.js` and `tests/api.test.js` (whole-database check after every scenario) |

## Verifying conformance

```bash
python data-model/tools/validate_postgres.py --csv-dir data-model/seed/csv \
  --conformance-script data-model/tools/validate_conformance.py --dsn "$DATABASE_URL"
```

Row counts are compared to the CSVs exactly (load-test rows, which are kept as `released` rows per R8 and use
`loadtest_` keys, are exempt). To return a database to the pristine seed:
`python data-model/tools/load_data.py --csv-dir data-model/seed/csv --truncate`.
