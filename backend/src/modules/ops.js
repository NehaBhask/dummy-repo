import { pool } from '../db.js';
import { checkInvariants } from './invariants.js';
import { describeInventory, getInventory, inventoryTitle } from './inventory/availability.js';
import { findContendedInventory } from './inventory/search.js';
import { releaseHold } from './booking/holds.js';
import { cancelBooking } from './booking/bookings.js';
import { listPersonas } from './session.js';

/*
 * Operations dashboard data: read-only counts straight from the tables, plus the invariant checks.
 *
 * Rejected attempts (sold_out) leave no database row — the transaction rolls back by design — so they are kept in a
 * small in-memory ring buffer for the activity feed. It resets when the server restarts; the hold and booking
 * rows in the feed come from the database and do not.
 */
const RING_SIZE = 200;
const rejections = [];

export function recordRejection(event) {
  rejections.unshift({ at: new Date().toISOString(), ...event });
  if (rejections.length > RING_SIZE) rejections.pop();
}

const countBy = async (table, since) => {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM ${table} ${since ? `WHERE created_at > now() - interval '${since}'` : ''} GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
};

// Application-made rows have keys like hold_… / trip_… / book_…; the provided seed data uses idem_… / hidem_….
const NOT_SEED = `idempotency_key !~ '^h?idem_'`;

export async function opsSummary({ inventoryId = null } = {}) {
  const [invariants, holds, bookings, recentHolds, recentBookings, totals, contended, feed] = await Promise.all([
    checkInvariants(),
    countBy('holds'),
    countBy('bookings'),
    countBy('holds', '60 minutes'),
    countBy('bookings', '60 minutes'),
    pool.query(
      `SELECT count(*)::int AS rows, COALESCE(sum(total_units),0)::int AS total, COALESCE(sum(booked_units),0)::int AS booked,
              COALESCE(sum(held_units),0)::int AS held FROM inventory_calendar`,
    ),
    findContendedInventory(12),
    activity(),
  ]);

  // Rooms people are actually acting on lead the picker (a room that just filled up no longer counts as
  // "scarce", so it would otherwise vanish exactly when it matters); the newest one is watched by default.
  const recentIds = [...new Set(feed.map((e) => e.inventory_id).filter(Boolean))];
  const recentRows = recentIds.length ? await roomsOf(recentIds) : [];
  const byId = new Map(recentRows.map((r) => [r.inventory_id, r]));
  const rooms = [
    ...recentIds.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id), recent: true })),
    ...contended.filter((c) => !byId.has(c.inventory_id)).map((c) => ({ ...c, recent: false })),
  ];
  const watchId = inventoryId ?? rooms[0]?.inventory_id ?? null;
  const watched = watchId ? await getInventory(watchId).catch(() => null) : null;
  const t = totals.rows[0];

  return {
    checked_at: new Date().toISOString(),
    invariants: { ok: invariants.ok, counts: invariants.counts, samples: invariants.samples },
    holds: { by_status: holds, last_hour: recentHolds },
    bookings: { by_status: bookings, last_hour: recentBookings },
    inventory: { rows: t.rows, total_units: t.total, booked_units: t.booked, held_units: t.held, free_units: t.total - t.booked - t.held },
    watched: watched && {
      inventory_id: watched.inventory_id,
      title: watched.title,
      for_date: watched.for_date,
      total_units: watched.total_units,
      booked_units: watched.booked_units,
      held_units: watched.held_units,
      free_units: watched.total_units - watched.booked_units - watched.held_units,
    },
    rooms,
    activity: feed,
    rejections_note: 'Rejected attempts are kept in memory since the last server start.',
  };
}

/** Room rows (with hotel and city, for the traveller deep link) for a set of inventory ids; flights are skipped. */
async function roomsOf(ids) {
  const { rows } = await pool.query(
    `SELECT ic.inventory_id, h.hotel_id, h.name AS hotel, c.name AS city, rt.name AS room_type, ic.for_date::text AS for_date,
            ic.total_units, ic.booked_units, ic.held_units, (ic.total_units - ic.booked_units - ic.held_units)::int AS free_units
       FROM inventory_calendar ic
       JOIN hotel_room_types rt ON rt.room_type_id = ic.entity_id AND ic.entity_type = 'room_type'
       JOIN hotels h ON h.hotel_id = rt.hotel_id
       JOIN cities c ON c.city_id = h.city_id
      WHERE ic.inventory_id = ANY($1::text[])`,
    [ids],
  );
  return rows;
}

/** Latest holds, bookings and rejected attempts, newest first, with who did it. */
async function activity(limit = 30) {
  const [holds, bookings] = await Promise.all([
    pool.query(
      `SELECT h.hold_id AS id, h.status, h.units, h.inventory_id, h.user_id, u.display_name, h.created_at AS at, h.expires_at
         FROM holds h JOIN users u ON u.user_id = h.user_id
        WHERE h.created_at > now() - interval '60 minutes' ORDER BY h.created_at DESC LIMIT $1`,
      [limit],
    ),
    pool.query(
      `SELECT b.booking_id AS id, b.status, b.booking_reference AS reference, b.total_amount::text AS amount, b.currency,
              b.user_id, u.display_name, b.created_at AS at
         FROM bookings b JOIN users u ON u.user_id = b.user_id
        WHERE b.created_at > now() - interval '60 minutes' ORDER BY b.created_at DESC LIMIT $1`,
      [limit],
    ),
  ]);
  const desc = await describeInventory([...new Set([...holds.rows.map((h) => h.inventory_id), ...rejections.map((r) => r.inventory_id).filter(Boolean)])]);
  const title = (id) => (desc.get(id) ? inventoryTitle(desc.get(id)) : id);

  return [
    ...holds.rows.map((h) => ({ kind: 'hold', at: h.at, id: h.id, status: h.status, user: { user_id: h.user_id, display_name: h.display_name }, what: title(h.inventory_id), inventory_id: h.inventory_id, units: h.units, expires_at: h.expires_at })),
    ...bookings.rows.map((b) => ({ kind: 'booking', at: b.at, id: b.id, status: b.status, user: { user_id: b.user_id, display_name: b.display_name }, what: `#${b.reference}`, amount: b.amount, currency: b.currency })),
    ...rejections.map((r) => ({ kind: 'rejected', at: r.at, id: null, status: r.code, user: r.user, what: r.inventory_id ? title(r.inventory_id) : '—', inventory_id: r.inventory_id, units: r.units })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

/**
 * Put the demo back: release every active hold and cancel every confirmed booking that the 10 demo travellers made
 * through the app (cancel restocks). Rows are marked, never deleted; the provided seed data is not touched.
 */
export async function resetDemo({ userIds } = {}) {
  const ids = userIds ?? (await listPersonas()).map((p) => p.user_id);
  const holds = (await pool.query(`SELECT hold_id, user_id FROM holds WHERE status = 'active' AND user_id = ANY($1) AND ${NOT_SEED}`, [ids])).rows;
  const bookings = (await pool.query(`SELECT booking_id, user_id FROM bookings WHERE status = 'confirmed' AND user_id = ANY($1) AND ${NOT_SEED}`, [ids])).rows;

  let releasedHolds = 0;
  for (const h of holds) {
    try {
      await releaseHold({ holdId: h.hold_id, userId: h.user_id });
      releasedHolds++;
    } catch { /* already gone (expired or confirmed meanwhile) */ }
  }
  let cancelledBookings = 0;
  for (const b of bookings) {
    try {
      await cancelBooking({ bookingId: b.booking_id, userId: b.user_id, reason: 'demo reset' });
      cancelledBookings++;
    } catch { /* already cancelled */ }
  }
  rejections.length = 0;
  return { released_holds: releasedHolds, cancelled_bookings: cancelledBookings };
}
