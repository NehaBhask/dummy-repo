#!/usr/bin/env python3
"""
validate_postgres.py — conformance + business-invariant checks against a live
Postgres load of APS-05, reusing the CONTRACT (prefixes, enums) already defined
in data-model/tools/validate_conformance.py so the two never drift apart.

Usage:
    export DATABASE_URL="postgresql://...railway.app:PORT/railway"
    python data-model/tools/validate_postgres.py --csv-dir data-model/seed/csv \
        --conformance-script data-model/tools/validate_conformance.py
"""
import argparse
import csv
import glob
import importlib.util
import os
import re
import sys

import psycopg


def load_contract(script_path: str) -> dict:
    spec = importlib.util.spec_from_file_location("validate_conformance", script_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)   # module-level code only; main() is __main__-guarded
    return mod.CONTRACT


def csv_row_counts(csv_dir: str) -> dict[str, int]:
    counts = {}
    for path in glob.glob(os.path.join(csv_dir, "*.csv")):
        table = re.sub(r"^\d+[_-]", "", os.path.splitext(os.path.basename(path))[0])
        with open(path, newline="", encoding="utf-8") as f:
            counts[table] = sum(1 for _ in csv.DictReader(f))
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", required=True)
    ap.add_argument("--conformance-script", required=True)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    if not args.dsn:
        sys.exit("set DATABASE_URL or pass --dsn")

    contract = load_contract(args.conformance_script)
    prefixes = contract["prefixes"]
    enums = contract["enums"]
    tables = contract["tables"]
    expected_counts = csv_row_counts(args.csv_dir)

    failures = []

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:

        # 1. Row counts match the CSVs exactly — except tables load_test.py writes to,
        # where its own loadtest_ prefixed rows are expected extras (R8: kept, not deleted)
        for table, expected in expected_counts.items():
            if table == "holds":
                cur.execute(
                    "SELECT COUNT(*) FROM holds WHERE idempotency_key NOT LIKE 'loadtest_%'"
                )
            else:
                cur.execute(f"SELECT COUNT(*) FROM {table}")
            got = cur.fetchone()[0]
            if got != expected:
                failures.append(f"[rowcount] {table}: expected {expected}, got {got}")

        # 2. ID prefixes — only for tables you were actually given
        for table in expected_counts:
            prefix = prefixes.get(table)
            pk = next((c["n"] for c in tables.get(table, []) if c["pk"]), None)
            if not prefix or not pk:
                continue
            cur.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {pk} !~ %s",
                (f"^{prefix}_",),
            )
            bad = cur.fetchone()[0]
            if bad:
                failures.append(f"[prefix] {table}.{pk}: {bad} row(s) missing '{prefix}_' prefix")

        # 3. Enum values legal — only for tables you were actually given
        for table in expected_counts:
            cols = tables.get(table, [])
            for c in cols:
                if not c["enum"]:
                    continue
                legal = enums[c["enum"]]
                cur.execute(
                    f"SELECT DISTINCT {c['n']} FROM {table} "
                    f"WHERE {c['n']} IS NOT NULL AND NOT ({c['n']} = ANY(%s))",
                    (legal,),
                )
                bad_vals = [r[0] for r in cur.fetchall()]
                if bad_vals:
                    failures.append(f"[enum] {table}.{c['n']}: illegal value(s) {bad_vals}")

        # 4. The oversell invariant (starter query #2) — must return nothing
        cur.execute(
            "SELECT inventory_id, total_units, booked_units, held_units "
            "FROM inventory_calendar WHERE booked_units + held_units > total_units"
        )
        oversold = cur.fetchall()
        if oversold:
            failures.append(f"[invariant] {len(oversold)} inventory row(s) oversold: {oversold[:5]}")

        # 5. Idempotency keys unique on bookings (starter query #4)
        cur.execute(
            "SELECT idempotency_key, COUNT(*) FROM bookings "
            "GROUP BY idempotency_key HAVING COUNT(*) > 1"
        )
        dupes = cur.fetchall()
        if dupes:
            failures.append(f"[idempotency] {len(dupes)} duplicate idempotency_key(s) in bookings: {dupes[:5]}")

    if failures:
        print(f"{len(failures)} finding(s):\n")
        for f in failures:
            print("  " + f)
        print("\nFAIL")
        sys.exit(1)

    print(f"Checked {len(expected_counts)} tables, {sum(expected_counts.values()):,} expected rows.")
    print("PASS")


if __name__ == "__main__":
    main()