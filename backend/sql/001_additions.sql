-- 001_additions.sql — additive only (Rule R1). Safe to run repeatedly.
-- Nothing provided with the data is renamed, dropped or repurposed.

-- ---------------------------------------------------------------------------------------------
-- New tables (design §7)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS load_test_runs (
  run_id               TEXT PRIMARY KEY,                       -- ltr_…
  target_inventory_id  TEXT NOT NULL REFERENCES inventory_calendar(inventory_id),
  mode                 TEXT NOT NULL CHECK (mode IN ('api', 'direct')),
  status               TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  concurrent_requests  INTEGER NOT NULL,
  duplicate_factor     INTEGER NOT NULL DEFAULT 1,             -- same idempotency key sent N times
  units_per_request    INTEGER NOT NULL DEFAULT 1,
  initial_free         INTEGER NOT NULL,
  expected_successes   INTEGER NOT NULL,
  successes            INTEGER NOT NULL DEFAULT 0,             -- distinct holds granted
  sold_out             INTEGER NOT NULL DEFAULT 0,
  errors               INTEGER NOT NULL DEFAULT 0,
  failures             INTEGER NOT NULL DEFAULT 0,             -- sold_out + errors
  invariant_violations INTEGER NOT NULL DEFAULT 0,             -- rows with booked+held > total
  oversold             BOOLEAN NOT NULL DEFAULT FALSE,
  p50_ms               NUMERIC(10,2),
  p95_ms               NUMERIC(10,2),
  p99_ms               NUMERIC(10,2),
  max_ms               NUMERIC(10,2),
  duration_ms          INTEGER,
  throughput_rps       NUMERIC(10,2),
  verdict              JSONB,                                  -- full checks incl. reconciliation
  created_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS load_test_results (
  result_id    TEXT PRIMARY KEY,                               -- ltrs_…
  run_id       TEXT NOT NULL REFERENCES load_test_runs(run_id),
  attempt_no   INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('success', 'sold_out', 'error')),
  latency_ms   NUMERIC(10,2) NOT NULL,
  http_status  INTEGER,
  error_code   TEXT,
  hold_id      TEXT,
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_load_test_results_run_id ON load_test_results(run_id);

CREATE TABLE IF NOT EXISTS search_logs (
  log_id         TEXT PRIMARY KEY,                             -- slg_…
  raw_query      TEXT NOT NULL,
  language       TEXT NOT NULL,                                -- BCP-47 (R6)
  parser         TEXT NOT NULL,                                -- gemini | heuristic | cache
  parsed_params  JSONB,
  result_count   INTEGER NOT NULL,
  latency_ms     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- New columns / indexes on existing tables
-- ---------------------------------------------------------------------------------------------
-- Ties a booking line to the hold it consumed, so saga compensation is exact even when two
-- lines of one booking point at the same inventory row.
ALTER TABLE booking_items ADD COLUMN IF NOT EXISTS hold_id TEXT;
CREATE INDEX IF NOT EXISTS idx_booking_items_hold_id ON booking_items(hold_id);

-- Expiry worker scans only live holds by deadline.
CREATE INDEX IF NOT EXISTS idx_holds_active_expiry ON holds(expires_at) WHERE status = 'active';

-- The provided CHECK (booked+held <= total) cannot see a counter going negative, which would
-- silently hide an oversell elsewhere. Add the missing half of the invariant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_calendar_nonneg_units') THEN
    ALTER TABLE inventory_calendar
      ADD CONSTRAINT inventory_calendar_nonneg_units CHECK (booked_units >= 0 AND held_units >= 0);
  END IF;
END $$;
