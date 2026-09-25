import { pool } from '../../db.js';
import { AppError } from '../../errors.js';

const DESCRIBE_SQL = `
  SELECT ic.inventory_id, ic.entity_type, ic.entity_id, ic.for_date::text AS for_date,
         ic.total_units, ic.booked_units, ic.held_units,
         (ic.total_units - ic.booked_units - ic.held_units) AS free_units,
         ic.price, ic.currency,
         rt.name AS room_name, h.hotel_id, h.name AS hotel_name, hc.name AS hotel_city,
         ff.cabin_class, ff.fare_class, f.flight_number,
         oa.iata AS origin_iata, da.iata AS dest_iata, dcity.name AS dest_city
    FROM inventory_calendar ic
    LEFT JOIN hotel_room_types rt ON ic.entity_type = 'room_type'   AND rt.room_type_id = ic.entity_id
    LEFT JOIN hotels h            ON h.hotel_id = rt.hotel_id
    LEFT JOIN cities hc           ON hc.city_id = h.city_id
    LEFT JOIN flight_fares ff     ON ic.entity_type = 'flight_fare' AND ff.fare_id = ic.entity_id
    LEFT JOIN flights f           ON f.flight_id = ff.flight_id
    LEFT JOIN airports oa         ON oa.airport_id = f.origin_airport_id
    LEFT JOIN airports da         ON da.airport_id = f.dest_airport_id
    LEFT JOIN cities dcity        ON dcity.city_id = da.city_id
   WHERE ic.inventory_id = ANY($1::text[])`;

/** Read-only (unlocked) inventory rows with human-readable context. Never use for decisions. */
export async function describeInventory(ids, client = pool) {
  const { rows } = await client.query(DESCRIBE_SQL, [[...new Set(ids)]]);
  return new Map(rows.map((r) => [r.inventory_id, r]));
}

export function inventoryTitle(r) {
  if (r.entity_type === 'room_type') return `${r.room_name} @ ${r.hotel_name}`;
  if (r.entity_type === 'flight_fare') {
    return `Flight ${r.flight_number} ${r.origin_iata}→${r.dest_iata} (${r.cabin_class}, ${r.fare_class})`;
  }
  return r.entity_id;
}

export async function getInventory(inventoryId) {
  const row = (await describeInventory([inventoryId])).get(inventoryId);
  if (!row) throw new AppError('invalid_id', { details: { inventory_id: inventoryId } });
  return { ...row, title: inventoryTitle(row) };
}

/**
 * Turn API hold items into concrete [{inventory_id, units}].
 * An item is either `{inventory_id, units}` or a stay/flight shorthand
 * `{entity_type, entity_id, for_date, nights, units}` that expands to one row per night.
 * Booking rules (min stay, closed-to-arrival) are enforced for room stays here.
 */
export async function resolveHoldItems(items) {
  const out = [];
  for (const it of items) {
    if (it.inventory_id) {
      out.push({ inventory_id: it.inventory_id, units: it.units });
      continue;
    }
    const nights = it.nights ?? 1;
    const { rows } = await pool.query(
      `SELECT inventory_id, for_date::text AS for_date, min_stay_nights, closed_to_arrival
         FROM inventory_calendar
        WHERE entity_type = $1 AND entity_id = $2
          AND for_date >= $3::date AND for_date < $3::date + $4::int
        ORDER BY for_date`,
      [it.entity_type, it.entity_id, it.for_date, nights],
    );
    if (rows.length !== nights) {
      throw new AppError('invalid_id', {
        details: { entity_id: it.entity_id, for_date: it.for_date, nights, found: rows.length },
      });
    }
    if (it.entity_type === 'room_type') {
      const first = rows[0];
      if (first.closed_to_arrival || nights < first.min_stay_nights) {
        throw new AppError('constraint_infeasible', {
          details: {
            closed_to_arrival: first.closed_to_arrival,
            min_stay_nights: first.min_stay_nights,
            requested_nights: nights,
          },
        });
      }
    }
    for (const r of rows) out.push({ inventory_id: r.inventory_id, units: it.units });
  }

  const seen = new Set();
  for (const it of out) {
    if (seen.has(it.inventory_id)) {
      throw new AppError('validation_error', { details: { duplicate_inventory_id: it.inventory_id } });
    }
    seen.add(it.inventory_id);
  }
  // Canonical order: ascending inventory_id. Also fixes each item's idempotency-key index.
  return out.sort((a, b) => (a.inventory_id < b.inventory_id ? -1 : 1));
}
