import { config } from '../../config.js';

/*
 * Flash-sale shield, in front of the database.
 *
 *  1. Sold-out memory: when a hold attempt finds a row full, remember "N units available" for a
 *     few hundred ms. Later requests for that row are rejected from memory, with no database call.
 *  2. Per-row queue: single-row hold attempts in this process run one at a time per inventory row.
 *     Waiting is cheap (a promise in memory); the alternative is dozens of database sessions all
 *     blocked on the same row lock, which makes Postgres slower, not faster.
 *
 * Both can only cause a false REJECTION, never a grant: a grant still requires the locked
 * check-and-reserve in Postgres. Staleness is bounded: entries expire after SOLD_OUT_CACHE_MS,
 * and this process clears them the moment it frees units (release, expiry, cancel, compensation).
 * Units freed by ANOTHER process become visible here after at most that TTL.
 */

const soldOut = new Map(); // inventory_id -> { until, available }
const gates = new Map(); // inventory_id -> tail promise of the queue

export const enabled = () => config.fastReject && config.soldOutCacheMs > 0;

export function markSoldOut(inventoryId, available) {
  if (!enabled()) return;
  soldOut.set(inventoryId, { until: Date.now() + config.soldOutCacheMs, available: Math.max(0, available ?? 0) });
  if (soldOut.size > 5000) {
    const now = Date.now();
    for (const [k, v] of soldOut) if (v.until <= now) soldOut.delete(k);
  }
}

/** Returns {inventory_id, requested, available} if any item is known to be unavailable, else null. */
export function knownSoldOut(items) {
  if (!enabled()) return null;
  const now = Date.now();
  for (const it of items) {
    const e = soldOut.get(it.inventory_id);
    if (!e) continue;
    if (e.until <= now) {
      soldOut.delete(it.inventory_id);
      continue;
    }
    if (it.units > e.available) return { inventory_id: it.inventory_id, requested: it.units, available: e.available };
  }
  return null;
}

/** Call whenever this process returns units to the pool. */
export function clearSoldOut(inventoryIds) {
  for (const id of inventoryIds) soldOut.delete(id);
}

/** Run `fn` after every earlier `fn` queued for the same row has finished. */
export async function withRowQueue(inventoryId, fn) {
  const prev = gates.get(inventoryId) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const tail = prev.then(() => mine);
  gates.set(inventoryId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (gates.get(inventoryId) === tail) gates.delete(inventoryId);
  }
}
