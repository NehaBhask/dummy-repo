import { pool } from '../db.js';

/**
 * The correctness proof, as queries. Everything here must come back empty / zero.
 *
 *  1. oversold        — booked + held > total          (the headline invariant)
 *  2. negative        — booked < 0 or held < 0         (would mask an oversell)
 *  3. held_drift      — held_units != Σ units of active holds on that row
 *  4. booked_drift    — booked_units != Σ units of confirmed booking items on that row
 *
 * (3) and (4) are stronger than (1): they show no unit was ever lost or double-counted, and
 * they hold on the untouched seed data, so any drift is caused by our code.
 * `scope` optionally narrows the check to specific inventory rows (used after a load test).
 */
export async function checkInvariants(client = pool, { inventoryIds = null } = {}) {
  const scope = inventoryIds ? 'AND ic.inventory_id = ANY($1::text[])' : '';
  const args = inventoryIds ? [inventoryIds] : [];

  const oversold = await client.query(
    `SELECT ic.inventory_id, ic.total_units, ic.booked_units, ic.held_units
       FROM inventory_calendar ic
      WHERE ic.booked_units + ic.held_units > ic.total_units ${scope}`,
    args,
  );
  const negative = await client.query(
    `SELECT ic.inventory_id, ic.booked_units, ic.held_units
       FROM inventory_calendar ic
      WHERE (ic.booked_units < 0 OR ic.held_units < 0) ${scope}`,
    args,
  );
  const heldDrift = await client.query(
    `SELECT ic.inventory_id, ic.held_units, COALESCE(h.u, 0)::int AS expected
       FROM inventory_calendar ic
       LEFT JOIN (SELECT inventory_id, SUM(units) u FROM holds WHERE status = 'active' GROUP BY 1) h
              ON h.inventory_id = ic.inventory_id
      WHERE ic.held_units <> COALESCE(h.u, 0) ${scope}`,
    args,
  );
  const bookedDrift = await client.query(
    `SELECT ic.inventory_id, ic.booked_units, COALESCE(b.u, 0)::int AS expected
       FROM inventory_calendar ic
       LEFT JOIN (SELECT inventory_id, SUM(units) u FROM booking_items WHERE status = 'confirmed' GROUP BY 1) b
              ON b.inventory_id = ic.inventory_id
      WHERE ic.booked_units <> COALESCE(b.u, 0) ${scope}`,
    args,
  );

  const counts = {
    oversold: oversold.rowCount,
    negative: negative.rowCount,
    held_drift: heldDrift.rowCount,
    booked_drift: bookedDrift.rowCount,
  };
  return {
    ok: Object.values(counts).every((n) => n === 0),
    counts,
    samples: {
      oversold: oversold.rows.slice(0, 5),
      negative: negative.rows.slice(0, 5),
      held_drift: heldDrift.rows.slice(0, 5),
      booked_drift: bookedDrift.rows.slice(0, 5),
    },
    checked_at: new Date().toISOString(),
  };
}
