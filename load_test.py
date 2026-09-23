#!/usr/bin/env python3
"""
load_test.py — concurrency load test for APS-05's inventory/hold invariant.

Targets the deliberately scarce inventory_calendar rows (starter query #1:
total_units <= 4, 1-3 free) and fires N concurrent holds at each, using the
correct atomic SQL pattern:

    UPDATE inventory_calendar
       SET held_units = held_units + $1
     WHERE inventory_id = $2
       AND booked_units + held_units + $1 <= total_units
    RETURNING inventory_id;

A SELECT-then-UPDATE from application code is exactly the race this exists to
catch. After the storm it re-checks the invariant (booked+held<=total) on every
targeted row and reports oversells, throughput and latency.

Test holds are tagged and released afterward (status='released', not deleted —
R8) so a shared Railway instance is left clean for teammates. Pass --keep to
leave them for inspection.

Usage:
    export DATABASE_URL="postgresql://...railway.app:PORT/railway"
    python load_test.py --workers 200 --targets 10
"""
import argparse
import asyncio
import os
import sys
import time
import uuid

import asyncpg

FIND_TARGETS = """
    SELECT inventory_id, total_units, booked_units, held_units,
           (total_units - booked_units - held_units) AS free
      FROM inventory_calendar
     WHERE total_units <= 4
       AND (total_units - booked_units - held_units) BETWEEN 1 AND 3
     ORDER BY random()
     LIMIT $1;
"""

TRY_HOLD = """
    UPDATE inventory_calendar
       SET held_units = held_units + 1
     WHERE inventory_id = $1
       AND booked_units + held_units + 1 <= total_units
    RETURNING inventory_id;
"""

INSERT_HOLD = """
    INSERT INTO holds (hold_id, inventory_id, user_id, units, idempotency_key,
                        created_at, expires_at, status, updated_at)
    VALUES ($1, $2, $3, 1, $4, now(), now() + interval '10 minutes', 'active', now());
"""

INVARIANT_CHECK = """
    SELECT inventory_id, total_units, booked_units, held_units
      FROM inventory_calendar
     WHERE inventory_id = ANY($1)
       AND booked_units + held_units > total_units;
"""

RELEASE_HOLDS = """
    WITH released AS (
        UPDATE holds SET status = 'released', released_at = now(), updated_at = now()
         WHERE idempotency_key LIKE $1 AND status = 'active'
        RETURNING inventory_id
    )
    UPDATE inventory_calendar ic
       SET held_units = held_units - sub.n
      FROM (SELECT inventory_id, COUNT(*) AS n FROM released GROUP BY inventory_id) sub
     WHERE ic.inventory_id = sub.inventory_id;
"""


async def one_attempt(pool, inventory_id, user_id, batch, i):
    idem = f"loadtest_{batch}_{uuid.uuid4().hex[:12]}"
    hold_id = f"hld_{uuid.uuid4().hex[:12]}"
    start = time.perf_counter()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(TRY_HOLD, inventory_id)
            granted = row is not None
            if granted:
                await conn.execute(INSERT_HOLD, hold_id, inventory_id, user_id, idem)
    return granted, time.perf_counter() - start


async def storm_target(pool, inventory_id, user_id, workers, batch):
    tasks = [one_attempt(pool, inventory_id, user_id, batch, i) for i in range(workers)]
    return await asyncio.gather(*tasks)


def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = int(len(sorted_vals) * p) 
    return sorted_vals[min(k, len(sorted_vals) - 1)]


async def warmup(pool):
    """Open every pooled connection now, so the first real target isn't the
    one paying for connection setup and skewing its latency numbers."""
    async def ping():
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
    await asyncio.gather(*(ping() for _ in range(pool.get_max_size())))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=200, help="concurrent hold attempts per target row")
    ap.add_argument("--targets", type=int, default=10, help="number of contended inventory rows to hit")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--keep", action="store_true", help="don't release test holds afterward")
    ap.add_argument("--release-batch", metavar="BATCH_ID",
                     help="skip the storm; just release a previous batch's leftover test holds "
                          "(the 8-char id printed at the start of a run) and exit")
    args = ap.parse_args()

    if not args.dsn:
        sys.exit("set DATABASE_URL or pass --dsn")

    if args.release_batch:
        pool = await asyncpg.create_pool(args.dsn, min_size=1, max_size=5)
        async with pool.acquire() as conn:
            await conn.execute(RELEASE_HOLDS, f"loadtest_{args.release_batch}_%")
        await pool.close()
        print(f"released any leftover test holds for batch {args.release_batch}")
        return

    batch = uuid.uuid4().hex[:8]
    pool = await asyncpg.create_pool(args.dsn, min_size=5, max_size=min(50, args.workers))
    await warmup(pool)

    async with pool.acquire() as conn:
        targets = await conn.fetch(FIND_TARGETS, args.targets)
        user_row = await conn.fetchrow("SELECT user_id FROM users LIMIT 1")

    if not targets:
        sys.exit("no contended inventory rows found (total_units<=4, 1-3 free) — is the data loaded?")
    user_id = user_row["user_id"]

    print(f"batch {batch}: {len(targets)} target row(s) x {args.workers} concurrent attempts\n")
    print(f"{'inventory_id':<16}{'free':>6}{'granted':>10}{'rejected':>10}"
          f"{'p50 ms':>10}{'p95 ms':>10}{'p99 ms':>10}")

    all_ids = []
    total_granted = total_rejected = 0
    for t in targets:
        results = await storm_target(pool, t["inventory_id"], user_id, args.workers, batch)
        latencies = sorted(lat * 1000 for _, lat in results)
        granted = sum(1 for ok, _ in results if ok)
        rejected = len(results) - granted
        total_granted += granted
        total_rejected += rejected
        all_ids.append(t["inventory_id"])
        print(f"{t['inventory_id']:<16}{t['free']:>6}{granted:>10}{rejected:>10}"
              f"{percentile(latencies,0.50):>10.1f}{percentile(latencies,0.95):>10.1f}"
              f"{percentile(latencies,0.99):>10.1f}")

    async with pool.acquire() as conn:
        oversold = await conn.fetch(INVARIANT_CHECK, all_ids)

    print(f"\n{total_granted} granted, {total_rejected} correctly rejected, "
          f"{len(oversold)} oversold row(s)")

    if oversold:
        print("\nOVERSELL DETECTED — the invariant failed under load:")
        for r in oversold:
            print(f"  {dict(r)}")

    if not args.keep:
        async with pool.acquire() as conn:
            await conn.execute(RELEASE_HOLDS, f"loadtest_{batch}_%")
        print(f"\nreleased test holds (batch {batch})")

    await pool.close()
    sys.exit(1 if oversold else 0)


if __name__ == "__main__":
    asyncio.run(main())