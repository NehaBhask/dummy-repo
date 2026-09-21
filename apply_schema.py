#!/usr/bin/env python3
"""
apply_schema.py — apply data/schema.sql to Postgres without needing the psql
client installed. Uses the same psycopg you already need for load_data.py.

Usage:
    set DATABASE_URL=postgresql://...railway.app:PORT/railway   (Windows cmd)
    $env:DATABASE_URL="postgresql://...railway.app:PORT/railway" (PowerShell)
    python apply_schema.py --schema ../kognivera/data/schema.sql
"""
import argparse
import os
import re
import sys

import psycopg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", required=True)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--skip-vector", action="store_true", default=True,
                     help="drop the 'CREATE EXTENSION vector' line (default on — Railway's "
                          "default image doesn't ship pgvector)")
    args = ap.parse_args()

    if not args.dsn:
        sys.exit("set DATABASE_URL first")

    sql = open(args.schema, encoding="utf-8").read()
    if args.skip_vector:
        sql = re.sub(r"^CREATE EXTENSION IF NOT EXISTS vector;.*$", "", sql, flags=re.M)

    with psycopg.connect(args.dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(sql)

    print("schema applied")


if __name__ == "__main__":
    main()