# APS-05 Data + QA toolkit

Covers your four responsibilities: Railway Postgres setup, data loading, a load-test
engine, and testing. Built against the `kognivera` repo's `data/schema.sql` and
`data/csv/*.csv`.

## 1. Railway Postgres setup

1. In Railway, **New Project → Provision PostgreSQL**.
2. Open the Postgres service → **Variables** tab → copy `DATABASE_URL`
   (looks like `postgresql://postgres:<pass>@<host>.railway.app:<port>/railway`).
3. Export it locally so every script below picks it up:
   ```bash
   export DATABASE_URL="postgresql://postgres:...@....railway.app:PORT/railway"
   ```
4. `schema.sql` has `CREATE EXTENSION IF NOT EXISTS vector;` at the top — Railway's
   Postgres image doesn't ship `pgvector` by default and nothing else in the schema
   depends on it.
5. Create the schema. **You don't need to install a Postgres server locally at all** —
   Railway already runs the server; you only need something that can talk to it.
   Two ways to do that:

   - **No extra install (recommended on Windows):** `apply_schema.py` uses the same
     `psycopg` you're already installing for `load_data.py`, and strips the
     `pgvector` line automatically:
     ```powershell
     pip install -r requirements.txt
     $env:DATABASE_URL="postgresql://...railway.app:PORT/railway"
     python apply_schema.py --schema ..\kognivera\data\schema.sql
     ```
   - **Or install the `psql` client** if you'd rather have a general-purpose Postgres
     CLI/GUI around: [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) →
     run the installer → when it asks which components, you only need **Command Line
     Tools** (uncheck "PostgreSQL Server" and "Stack Builder" if you don't want a
     local server running too) → it also installs pgAdmin, a GUI if you want to browse
     tables visually. Then, from a **new** terminal (so PATH picks up `psql`):
     ```powershell
     $env:DATABASE_URL="postgresql://...railway.app:PORT/railway"
     psql $env:DATABASE_URL -c "$(Get-Content -Raw ..\kognivera\data\schema.sql -replace 'CREATE EXTENSION.*vector;','')"
     ```
     (or simpler: open the file, delete the `CREATE EXTENSION vector` line, then
     `psql $env:DATABASE_URL -f ..\kognivera\data\schema.sql`.)
6. Give teammates the `DATABASE_URL` (or a read-only Railway-generated one for
   whoever's just querying) rather than re-provisioning per person — one shared
   instance keeps everyone's holds/bookings tests consistent.

## 2. Data loading — `load_data.py`

Loads all 20 CSVs in `data/csv/` in their numbered order (so foreign keys resolve),
using Postgres `COPY`, and prints a row-count summary at the end.

```bash
pip install -r requirements.txt
python load_data.py --csv-dir ../kognivera/data/csv
```

Re-running is safe: pass `--truncate` to wipe all 20 tables first (reverse FK order)
before reloading, which is what you want after a schema change or a bad load.

```bash
python load_data.py --csv-dir ../kognivera/data/csv --truncate
```

Money columns need no special handling here — unlike the SQLite `.db` (where money is
`TEXT` on purpose, see `data/WORKING_WITH_THE_DATA.md`), the Postgres schema declares
them `NUMERIC(12,2)`, and Postgres `COPY` parses decimal text exactly. The float trap
only exists once *you* pull a value out into application code — never round-trip it
through a `float`/`double` there either.

## 3. Testing — `validate_postgres.py`

Runs the same conformance checks `tools/validate_conformance.py` runs against the
SQLite copy, but as live SQL against your loaded Postgres instance, plus the specific
invariants called out in `data/queries/starter_queries.sql`:

```bash
python validate_postgres.py
```

Checks: row counts match the CSVs exactly, every enum value is in `data/enums.json`,
every ID column carries its canonical prefix, `booked_units + held_units <= total_units`
never fails (query #2), and no `idempotency_key` on `bookings` is reused (query #4).
Exits non-zero with a summary of failures — wire it into CI so a bad load or a schema
drift fails the build instead of surfacing during the hackathon.

## 4. Load test engine — `load_test.py`

The design doc is explicit about where this should aim: not random inventory, but the
deliberately scarce rows (`total_units <= 4`) where two concurrent holds can legally
race for the last unit. This script:

1. Finds contended `inventory_calendar` rows automatically (same query as starter
   query #1).
2. Fires N concurrent workers at each one, each trying to place a hold via the
   correct atomic pattern:
   ```sql
   UPDATE inventory_calendar
      SET held_units = held_units + %(units)s
    WHERE inventory_id = %(id)s
      AND booked_units + held_units + %(units)s <= total_units
    RETURNING inventory_id;
   ```
   (a `SELECT` then `UPDATE` from application code is exactly the race this is meant
   to catch — this script's reference implementation is what "correct" looks like).
3. After the storm, re-runs the invariant query. Any row where it fails is an oversell.
4. Reports: requests fired, holds granted vs correctly rejected, oversells (should
   always be 0), and p50/p95/p99 latency.

```bash
python load_test.py --workers 200 --targets 10
```

Once your teammates' booking API exists, point `--mode api` (stubbed in the script)
at its hold endpoint instead of hitting Postgres directly — the DB-level version here
is the ground truth to compare it against.

## Files

| File | Role |
|---|---|
| `apply_schema.py` | Applies `schema.sql` via psycopg — no `psql` client needed |
| `load_data.py` | Loads schema-ordered CSVs into Postgres |
| `validate_postgres.py` | Conformance + invariant tests against live DB |
| `load_test.py` | Concurrency load test on contended inventory |
| `requirements.txt` | `psycopg[binary]`, `asyncpg` |