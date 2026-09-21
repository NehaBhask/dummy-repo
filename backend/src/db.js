import pg from 'pg';
import { config } from './config.js';

// DATE columns come back as plain 'YYYY-MM-DD' strings (R4: dates carry no zone), not JS Dates
// that would shift with the server's timezone. NUMERIC already arrives as a string (R3).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  idleTimeoutMillis: 30_000,
  // Callers queue for a free connection instead of Postgres refusing them; this bounds that wait.
  connectionTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[pg pool] idle client error:', err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn(client)` in a READ COMMITTED transaction (row locks, not SERIALIZABLE — see design §5).
 *
 * - `lock_timeout` is set per transaction so a contended request fails fast instead of hanging.
 * - Deadlocks (40P01) are retried; every caller's `fn` is safe to re-run because it either
 *   commits fully or not at all and holds no external side effects.
 * - No network I/O other than the DB itself belongs inside `fn` (design: no I/O in locked txns).
 */
export async function withTx(fn, { lockTimeoutMs = config.lockTimeoutMs, deadlockRetries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(`BEGIN; SET LOCAL lock_timeout = '${Math.trunc(lockTimeoutMs)}ms'`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // connection is unusable; make the pool discard it
      }
      if (err?.code === '40P01' && attempt < deadlockRetries) {
        await sleep(5 + Math.random() * 20 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}

/**
 * Lock inventory rows FOR UPDATE in ascending inventory_id order. Every code path that locks more
 * than one inventory row goes through here, so two concurrent multi-row operations can never
 * acquire the same rows in opposite order (design §5: fixed lock ordering).
 * (LockRows sits above Sort in the plan, so ORDER BY … FOR UPDATE locks in sorted order.)
 */
export async function lockInventory(client, ids) {
  const unique = [...new Set(ids)].sort();
  const { rows } = await client.query(
    `SELECT inventory_id, entity_type, entity_id, for_date::text AS for_date, total_units,
            booked_units, held_units, price, currency, min_stay_nights, closed_to_arrival
       FROM inventory_calendar
      WHERE inventory_id = ANY($1::text[])
      ORDER BY inventory_id
        FOR UPDATE`,
    [unique],
  );
  return rows;
}

export async function closePool() {
  await pool.end();
}
