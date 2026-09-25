import { pool, withTx, lockInventory } from '../../db.js';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { describeInventory, inventoryTitle } from '../inventory/availability.js';
import { D } from '../../money.js';
import { assertCurrency, convert, fxContext, moneyOut } from '../../fx.js';
import {
  clearSoldOut, enabled as soldOutEnabled, knownSoldOut, markSoldOut, withRowQueue,
} from '../inventory/soldout.js';

/*
 * TTL holds.
 *
 * A hold request may span several inventory rows (one per night, or hotel + flight). The holds
 * table has one inventory_id per row, so a request becomes N hold rows created atomically. Each
 * row's idempotency_key is derived as `<client key>#<i>` where i is its index in ascending
 * inventory_id order — deterministic for a given request, and uniquely decodable.
 *
 * Concurrency, in order, inside one READ COMMITTED transaction:
 *   1. lock every inventory row FOR UPDATE in ascending id order   (no deadlock between requests)
 *   2. check booked + held + requested <= total on every row
 *   3. INSERT holds … ON CONFLICT (idempotency_key) DO NOTHING     (atomic idempotency backstop)
 *   4. UPDATE held_units, COMMIT
 *
 * Idempotency without extra work under the lock: a retry either wins nothing (its INSERT hits the
 * unique key → rolled back → resolved as a replay) or finds the row sold out (rolled back →
 * resolved as a replay if its key already owns a hold, else a genuine sold_out). Both resolutions
 * run AFTER the rollback, outside the lock, so every millisecond the row lock is held is spent
 * only on the decision itself — the lock hold time is what bounds throughput under contention.
 *
 * Step 1 must come before step 4. holds.inventory_id is a foreign key, so inserting a hold takes
 * FOR KEY SHARE on the inventory row; two requests that each did that first and then asked for
 * FOR UPDATE would deadlock on each other. Locking first makes the FK check a no-op re-lock.
 */

const holdKey = (key, i) => `${key}#${i}`;
const COLS = `hold_id, inventory_id, user_id, units, idempotency_key, status,
              created_at, expires_at, released_at, booking_id`;

class IdempotentRace extends Error {}
class SoldOutUnderLock extends Error {
  constructor(details) {
    super('sold_out');
    this.details = details;
  }
}

const conflict = (extra) => new AppError('idempotency_conflict', { details: extra });

async function findByKeys(client, keys) {
  const { rows } = await client.query(`SELECT ${COLS} FROM holds WHERE idempotency_key = ANY($1::text[])`, [keys]);
  return rows;
}

// A key that already exists must map to exactly the same request, otherwise it is a client bug
// (same key, different body) and we refuse rather than silently return someone else's hold.
function replayFrom(existing, items, userId, key) {
  const byKey = new Map(existing.map((h) => [h.idempotency_key, h]));
  if (byKey.has(holdKey(key, items.length))) throw conflict({ reason: 'key was used for a larger request' });
  return items.map((it, i) => {
    const h = byKey.get(holdKey(key, i));
    if (!h || h.inventory_id !== it.inventory_id || h.units !== it.units || h.user_id !== userId) {
      throw conflict({ reason: 'key was used for a different request' });
    }
    return h;
  });
}

export async function createHold({ userId, items, idempotencyKey, ttlSeconds, bypassShield = false }) {
  const ttl = Math.min(
    Math.max(ttlSeconds ?? config.holdTtlSeconds, config.holdTtlMinSeconds),
    config.holdTtlMaxSeconds,
  );
  const keys = items.map((_, i) => holdKey(idempotencyKey, i));
  const probe = [...keys, holdKey(idempotencyKey, items.length)];

  // Retry of a request that already won: answer from the holds table, no locks, no queue.
  const early = await findByKeys(pool, probe);
  if (early.length) return { holds: replayFrom(early, items, userId, idempotencyKey), replayed: true };

  // Flash-sale shield (see modules/inventory/soldout.js): reject what is known to be sold out, and
  // run single-row attempts one at a time per row so waiting happens in memory, not on DB locks.
  // Can only reject early, never grant; the locked check-and-reserve below is what grants.
  // bypassShield (load tests / dev only) sends every request straight to Postgres so the row lock,
  // not the in-process queue, is what gets tested.
  const shield = soldOutEnabled() && !bypassShield;
  const reject = (hit) => new AppError('sold_out', { details: hit });
  const known = shield ? knownSoldOut(items) : null;
  if (known) throw reject(known);

  const attempt = async () => {
    try {
      return await reserve({ userId, items, keys, probe, idempotencyKey, ttl });
    } catch (err) {
      if (shield && err instanceof AppError && err.code === 'sold_out' && err.details?.inventory_id) {
        markSoldOut(err.details.inventory_id, err.details.available);
      }
      throw err;
    }
  };
  if (items.length === 1 && shield) {
    return withRowQueue(items[0].inventory_id, async () => {
      const again = knownSoldOut(items); // an earlier request in the queue may have just sold it out
      if (again) throw reject(again);
      return attempt();
    });
  }
  return attempt();
}

// Reserve the rows: one Postgres function call, or the equivalent Node-side transaction.
async function reserve({ userId, items, keys, probe, idempotencyKey, ttl }) {
  if (config.holdImpl === 'sql') {
    return createViaFunction({ userId, items, keys, probe, idempotencyKey, ttl });
  }

  try {
    return await withTx(async (c) => {
      const ids = items.map((i) => i.inventory_id);
      const rows = await lockInventory(c, ids);
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => r.inventory_id));
        throw new AppError('invalid_id', { details: { inventory_id: ids.find((id) => !found.has(id)) } });
      }

      const byId = new Map(rows.map((r) => [r.inventory_id, r]));
      for (const it of items) {
        const r = byId.get(it.inventory_id);
        const free = r.total_units - r.booked_units - r.held_units;
        if (it.units > free) {
          throw new SoldOutUnderLock({ inventory_id: it.inventory_id, requested: it.units, available: Math.max(free, 0) });
        }
      }

      const inserted = await c.query(
        `INSERT INTO holds (hold_id, inventory_id, user_id, units, idempotency_key,
                            created_at, expires_at, status, updated_at)
         SELECT u.hold_id, u.inventory_id, $5, u.units, u.idem,
                statement_timestamp(), statement_timestamp() + make_interval(secs => $6), 'active', statement_timestamp()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS u(hold_id, inventory_id, units, idem)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${COLS}`,
        [
          items.map(() => newId('hld')),
          ids,
          items.map((i) => i.units),
          keys,
          userId,
          ttl,
        ],
      );
      // The key already owns a hold (a retry of a request that won), or the same key was reused for
      // a different row set. Roll back (removing any partial insert) and resolve outside the lock.
      if (inserted.rowCount !== items.length) throw new IdempotentRace();

      await c.query(
        `UPDATE inventory_calendar ic
            SET held_units = ic.held_units + u.units, updated_at = statement_timestamp()
           FROM unnest($1::text[], $2::int[]) AS u(id, units)
          WHERE ic.inventory_id = u.id`,
        [ids, items.map((i) => i.units)],
      );

      const byKey = new Map(inserted.rows.map((h) => [h.idempotency_key, h]));
      return { holds: keys.map((k) => byKey.get(k)), replayed: false };
    });
  } catch (err) {
    if (err instanceof IdempotentRace || err instanceof SoldOutUnderLock) {
      const rows = await findByKeys(pool, probe); // lock already released
      if (rows.length) return { holds: replayFrom(rows, items, userId, idempotencyKey), replayed: true };
      if (err instanceof SoldOutUnderLock) throw new AppError('sold_out', { details: err.details });
    }
    throw err;
  }
}

// Same algorithm as the JS transaction above, executed inside Postgres in a single round trip
// (see data-model/migrations/002_create_holds_function.sql). Outcomes that need a replay lookup run after the
// statement has finished, i.e. with the row lock already released.
async function createViaFunction({ userId, items, keys, probe, idempotencyKey, ttl }) {
  const args = [
    userId,
    items.map((i) => i.inventory_id),
    items.map((i) => i.units),
    keys,
    items.map(() => newId('hld')),
    ttl,
    config.lockTimeoutMs,
  ];
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = (await pool.query('SELECT kognivera_create_holds($1,$2,$3,$4,$5,$6,$7) AS r', args)).rows[0].r;
      break;
    } catch (err) {
      if (err.code === 'P0001' && err.message === 'idempotency_race') {
        result = { outcome: 'race' };
        break;
      }
      if (err.code === '40P01' && attempt < 3) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  switch (result.outcome) {
    case 'created':
      return {
        replayed: false,
        holds: result.holds.map((h) => ({
          ...h,
          created_at: new Date(h.created_at),
          expires_at: new Date(h.expires_at),
          released_at: h.released_at ? new Date(h.released_at) : null,
        })),
      };
    case 'missing':
      throw new AppError('invalid_id', { details: { inventory_id: result.inventory_id } });
    default: {
      // 'sold_out' or 'race': the key may already own a hold (a retry of the request that won)
      const rows = await findByKeys(pool, probe);
      if (rows.length) return { holds: replayFrom(rows, items, userId, idempotencyKey), replayed: true };
      if (result.outcome === 'sold_out') {
        throw new AppError('sold_out', {
          details: { inventory_id: result.inventory_id, requested: items.find((i) => i.inventory_id === result.inventory_id)?.units, available: result.available },
        });
      }
      throw new Error('idempotency race without a visible winner');
    }
  }
}

/**
 * The traveller's own live reservations (status active, deadline not passed), each described well enough for the trip page
 * to show it: what it is, when it stays and what it costs (in `currency`, default the row's own).
 */
export async function listActiveHolds({ userId, currency } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM holds WHERE user_id = $1 AND status = 'active' AND expires_at > statement_timestamp() ORDER BY expires_at, created_at`,
    [userId],
  );
  const inv = await describeInventory(rows.map((h) => h.inventory_id));
  const fx = await fxContext();
  if (currency) assertCurrency(fx, currency);
  return rows.map((h) => {
    const i = inv.get(h.inventory_id);
    const out = currency ?? i?.currency;
    const total = i ? convert(fx, D(i.price).mul(h.units).toFixed(2), i.currency, out) : null;
    return {
      ...h,
      seconds_remaining: Math.max(0, Math.floor((new Date(h.expires_at) - Date.now()) / 1000)),
      inventory: i ? { ...i, title: inventoryTitle(i) } : null,
      price: total && moneyOut(fx, total, out),
    };
  });
}

export async function getHold(holdId, { userId } = {}) {
  const { rows } = await pool.query(`SELECT ${COLS} FROM holds WHERE hold_id = $1`, [holdId]);
  const hold = rows[0];
  if (!hold) throw new AppError('invalid_id', { details: { hold_id: holdId } });
  if (userId && hold.user_id !== userId) throw new AppError('forbidden');
  const inv = (await describeInventory([hold.inventory_id])).get(hold.inventory_id);
  return {
    ...hold,
    seconds_remaining:
      hold.status === 'active' ? Math.max(0, Math.floor((new Date(hold.expires_at) - Date.now()) / 1000)) : 0,
    inventory: inv ? { ...inv, title: inventoryTitle(inv) } : null,
  };
}

/** Voluntary release (traveller abandons the hold). Idempotent for holds already released/expired. */
export async function releaseHold({ holdId, userId }) {
  return withTx(async (c) => {
    // Lock order for anything touching an existing hold: hold row → inventory row.
    const { rows } = await c.query(`SELECT ${COLS} FROM holds WHERE hold_id = $1 FOR UPDATE`, [holdId]);
    const h = rows[0];
    if (!h) throw new AppError('invalid_id', { details: { hold_id: holdId } });
    if (userId && h.user_id !== userId) throw new AppError('forbidden');
    if (h.status === 'confirmed') throw new AppError('invalid_state', { details: { status: h.status } });
    if (h.status !== 'active') return h;

    await lockInventory(c, [h.inventory_id]);
    await c.query(
      `UPDATE inventory_calendar SET held_units = held_units - $2, updated_at = statement_timestamp()
        WHERE inventory_id = $1`,
      [h.inventory_id, h.units],
    );
    clearSoldOut([h.inventory_id]);
    const upd = await c.query(
      `UPDATE holds
          SET status = CASE WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE 'released' END,
              released_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE hold_id = $1
        RETURNING ${COLS}`,
      [holdId],
    );
    return upd.rows[0];
  });
}

/**
 * Expire every active hold past its deadline and return its units to the pool.
 * Called by the worker; `inventoryIds` narrows the sweep (used by tests so they don't touch seed data).
 * pg_try_advisory_xact_lock makes a second instance skip instead of double-processing, which
 * closes the "single-instance worker" limitation noted in the design.
 */
export async function expireHolds({ inventoryIds = null, batchSize = 500 } = {}) {
  return withTx(async (c) => {
    const lock = await c.query(`SELECT pg_try_advisory_xact_lock(hashtext('kognivera:expire_holds')) AS ok`);
    if (!lock.rows[0].ok) return { skipped: true, expired: 0, inventory_rows: 0 };

    const { rows } = await c.query(
      `SELECT hold_id, inventory_id, units
         FROM holds
        WHERE status = 'active'
          AND expires_at <= statement_timestamp()
          AND ($2::text[] IS NULL OR inventory_id = ANY($2::text[]))
        ORDER BY expires_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize, inventoryIds],
    );
    if (!rows.length) return { skipped: false, expired: 0, inventory_rows: 0 };

    const perRow = new Map();
    for (const h of rows) perRow.set(h.inventory_id, (perRow.get(h.inventory_id) ?? 0) + h.units);

    await lockInventory(c, [...perRow.keys()]); // sorted, after the hold rows (see releaseHold)
    clearSoldOut([...perRow.keys()]);
    await c.query(
      `UPDATE holds SET status = 'expired', released_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE hold_id = ANY($1::text[])`,
      [rows.map((h) => h.hold_id)],
    );
    await c.query(
      `UPDATE inventory_calendar ic
          SET held_units = ic.held_units - u.n, updated_at = statement_timestamp()
         FROM unnest($1::text[], $2::int[]) AS u(id, n)
        WHERE ic.inventory_id = u.id`,
      [[...perRow.keys()], [...perRow.values()]],
    );
    return { skipped: false, expired: rows.length, inventory_rows: perRow.size };
  });
}
