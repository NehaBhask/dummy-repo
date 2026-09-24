import { randomBytes } from 'node:crypto';
import { pool, closePool } from '../backend/src/db.js';
import { newId } from '../backend/src/ids.js';

/*
 * Test fixtures live in inventory_calendar rows dated 2031+ (the seed covers Sep–Nov 2026), so
 * tests never touch seed inventory and can be wiped precisely. Tests run against the real
 * Postgres — the guarantees under test are Postgres' row locks, so mocking it would prove nothing.
 */
const FIXTURE_FROM = '2031-01-01';

export const uniq = () => randomBytes(4).toString('hex');

export async function makeInventory({ total = 3, type = 'room_type', price = '1000.00' } = {}) {
  const src =
    type === 'room_type'
      ? await pool.query('SELECT room_type_id AS id, currency FROM hotel_room_types ORDER BY random() LIMIT 1')
      : await pool.query('SELECT fare_id AS id, currency FROM flight_fares ORDER BY random() LIMIT 1');
  const { id: entityId, currency } = src.rows[0];

  for (let attempt = 0; attempt < 20; attempt++) {
    const offset = Math.floor(Math.random() * 3000);
    const { rows } = await pool.query(
      `INSERT INTO inventory_calendar (inventory_id, entity_type, entity_id, for_date, total_units,
                                       booked_units, held_units, price, currency, min_stay_nights,
                                       closed_to_arrival, updated_at)
       VALUES ($1, $2, $3, $4::date + $5::int, $6, 0, 0, $7, $8, 1, false, now())
       ON CONFLICT DO NOTHING
       RETURNING inventory_id, entity_id, for_date::text AS for_date, currency`,
      [newId('inv'), type, entityId, FIXTURE_FROM, offset, total, price, currency],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('could not allocate fixture inventory');
}

export async function readInventory(inventoryId) {
  const { rows } = await pool.query(
    'SELECT total_units, booked_units, held_units, price::text AS price FROM inventory_calendar WHERE inventory_id = $1',
    [inventoryId],
  );
  return rows[0];
}

let users = null;
export async function testUsers() {
  users ??= (
    await pool.query(
      `SELECT user_id, home_currency FROM users WHERE status = 'active' AND home_currency = 'INR' ORDER BY user_id LIMIT 2`,
    )
  ).rows;
  return users;
}

export async function cleanupTestData() {
  const inv = `SELECT inventory_id FROM inventory_calendar WHERE for_date >= '${FIXTURE_FROM}'`;
  await pool.query(
    `DELETE FROM load_test_results WHERE run_id IN (SELECT run_id FROM load_test_runs WHERE target_inventory_id IN (${inv}))`,
  );
  await pool.query(`DELETE FROM load_test_runs WHERE target_inventory_id IN (${inv})`);
  const { rows } = await pool.query(`SELECT DISTINCT booking_id FROM booking_items WHERE inventory_id IN (${inv})`);
  const bookingIds = rows.map((r) => r.booking_id);
  await pool.query('DELETE FROM payments WHERE booking_id = ANY($1::text[])', [bookingIds]);
  await pool.query(`DELETE FROM holds WHERE booking_id = ANY($1::text[]) OR inventory_id IN (${inv})`, [bookingIds]);
  await pool.query('DELETE FROM booking_items WHERE booking_id = ANY($1::text[])', [bookingIds]);
  await pool.query('DELETE FROM bookings WHERE booking_id = ANY($1::text[])', [bookingIds]);
  await pool.query(`DELETE FROM inventory_calendar WHERE for_date >= '${FIXTURE_FROM}'`);
}

export async function finish() {
  await cleanupTestData();
  await closePool();
}
