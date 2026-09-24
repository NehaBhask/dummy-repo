#!/usr/bin/env python3
"""
load_data.py — load APS-05's data-model/seed/csv/*.csv into Postgres via COPY.

Usage:
    export DATABASE_URL="postgresql://...railway.app:PORT/railway"
    python data-model/tools/load_data.py --csv-dir data-model/seed/csv
    python data-model/tools/load_data.py --csv-dir data-model/seed/csv --truncate   # wipe first

Requires the schema already applied (see README step 1.5):
    psql "$DATABASE_URL" -f data-model/schema.sql
"""
import argparse
import glob
import os
import re
import sys
import time

import psycopg


def table_name_for(csv_path: str) -> str:
    stem = os.path.splitext(os.path.basename(csv_path))[0]
    return re.sub(r"^\d+[_-]", "", stem)


def ordered_csvs(csv_dir: str) -> list[tuple[str, str]]:
    paths = sorted(glob.glob(os.path.join(csv_dir, "*.csv")))
    if not paths:
        sys.exit(f"no CSVs found in {csv_dir}")
    return [(table_name_for(p), p) for p in paths]


def load(conn, table: str, path: str) -> int:
    with conn.cursor() as cur, open(path, "rb") as f:
        with cur.copy(f"COPY {table} FROM STDIN WITH (FORMAT csv, HEADER true)") as copy:
            while chunk := f.read(1 << 20):
                copy.write(chunk)
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        return cur.fetchone()[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", required=True)
    ap.add_argument("--truncate", action="store_true",
                     help="TRUNCATE all target tables (reverse load order) before loading")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    if not args.dsn:
        sys.exit("set DATABASE_URL or pass --dsn")

    pairs = ordered_csvs(args.csv_dir)

    with psycopg.connect(args.dsn) as conn:
        if args.truncate:
            tables = ", ".join(t for t, _ in reversed(pairs))
            print(f"truncating: {tables}")
            with conn.cursor() as cur:
                cur.execute(f"TRUNCATE {tables} RESTART IDENTITY CASCADE")
            conn.commit()

        print(f"{'table':<24}{'rows':>10}   time")
        t0 = time.time()
        for table, path in pairs:
            start = time.time()
            try:
                n = load(conn, table, path)
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"{table:<24}{'FAILED':>10}   {e}")
                sys.exit(1)
            print(f"{table:<24}{n:>10}   {time.time() - start:.2f}s")
        print(f"\ndone in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()