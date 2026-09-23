import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { createHold } from '../src/modules/booking/holds.js';
import { confirmBooking, cancelBooking, getBooking } from '../src/modules/booking/bookings.js';
import { checkInvariants } from '../src/modules/invariants.js';
import { fxContext, convert } from '../src/fx.js';
import { makeInventory, readInventory, testUsers, uniq, cleanupTestData, finish } from './helpers.js';

let user;
let other;
before(async () => {
  await cleanupTestData();
  [user, other] = await testUsers();
});
after(finish);

const key = () => `test_${uniq()}`;
const holdOn = async (inv, units = 1, userId = user.user_id) =>
  (await createHold({ userId, items: [{ inventory_id: inv.inventory_id, units }], idempotencyKey: key() })).holds[0];
const book = (holds, extra = {}) =>
  confirmBooking({
    userId: user.user_id,
    idempotencyKey: key(),
    items: holds.map((h) => ({ hold_id: h.hold_id })),
    ...extra,
  });
const scopedOk = async (...invs) => {
  const r = await checkInvariants(pool, { inventoryIds: invs.map((i) => i.inventory_id) });
  assert.ok(r.ok, JSON.stringify(r));
};
const holdStatus = async (id) => (await pool.query('SELECT status FROM holds WHERE hold_id = $1', [id])).rows[0].status;

test('confirm: hold becomes a booking, held→booked, payment captured, tax rule matches the seed', async () => {
  const inv = await makeInventory({ total: 5, price: '1000.00' });
  const h = await holdOn(inv, 2);
  const r = await book([h]);
  assert.equal(r.outcome, 'confirmed');
  const b = r.booking;
  assert.equal(b.status, 'confirmed');
  assert.equal(b.currency, inv.currency);
  assert.equal(b.total_amount, '2240.00'); // 2 × 1000.00 = 2000.00, +12% = 2240.00
  assert.equal(b.tax_amount, '240.00');
  assert.equal(b.payment.status, 'captured');
  assert.equal(b.payment.captured_amount, '2240.00');
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].status, 'confirmed');
  assert.equal(b.items[0].line_total, '2000.00');
  assert.match(b.booking_reference, /^[0-9A-F]{6}$/);

  const row = await readInventory(inv.inventory_id);
  assert.equal(row.booked_units, 2);
  assert.equal(row.held_units, 0);
  assert.equal(await holdStatus(h.hold_id), 'confirmed');
  await scopedOk(inv);
});

test('idempotent confirm: a retry returns the same booking and never books twice', async () => {
  const inv = await makeInventory({ total: 5 });
  const h = await holdOn(inv, 1);
  const k = key();
  const args = { userId: user.user_id, idempotencyKey: k, items: [{ hold_id: h.hold_id }] };
  const a = await confirmBooking(args);
  const b = await confirmBooking(args);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(a.booking.booking_id, b.booking.booking_id);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 1);
  await assert.rejects(
    confirmBooking({ ...args, items: [{ hold_id: (await holdOn(inv, 1)).hold_id }] }),
    { code: 'idempotency_conflict' },
    'same key, different holds is refused',
  );
});

test('idempotent confirm: 20 simultaneous retries yield exactly one booking', async () => {
  const inv = await makeInventory({ total: 5 });
  const h = await holdOn(inv, 1);
  const args = { userId: user.user_id, idempotencyKey: key(), items: [{ hold_id: h.hold_id }] };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => confirmBooking(args)));

  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((r) => r.value.booking.booking_id)).size, 1, 'everyone who got an answer got the same booking');
  assert.ok(bad.every((r) => r.reason.code === 'request_in_progress'), 'the rest were told to retry, not double-booked');
  assert.equal(ok.filter((r) => !r.value.replayed).length, 1, 'exactly one request ran the saga');

  const n = await pool.query('SELECT count(*)::int n FROM bookings WHERE idempotency_key = $1', [args.idempotencyKey]);
  assert.equal(n.rows[0].n, 1);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 1);
  assert.equal((await confirmBooking(args)).booking.status, 'confirmed', 'a later retry gets the stored result');
});

test('multi-item saga: an expired flight hold rolls the hotel booking back cleanly', async () => {
  const hotel = await makeInventory({ total: 3, type: 'room_type' });
  const flight = await makeInventory({ total: 3, type: 'flight_fare' });
  const hh = await holdOn(hotel, 1);
  const fh = await holdOn(flight, 1);
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [fh.hold_id]);

  const r = await book([hh, fh]);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.failure.code, 'hold_expired');
  const b = r.booking;
  assert.equal(b.status, 'failed');
  assert.deepEqual(b.items.map((i) => i.status), ['compensated', 'compensated']);
  assert.ok(b.items.every((i) => i.compensated_at));
  assert.equal(b.payment.status, 'failed');
  assert.equal(b.payment.failure_code, 'hold_expired');

  // The hotel had been confirmed and must be fully restocked; the flight hold given back.
  assert.equal((await readInventory(hotel.inventory_id)).booked_units, 0);
  assert.equal((await readInventory(hotel.inventory_id)).held_units, 0);
  assert.equal((await readInventory(flight.inventory_id)).held_units, 0);
  assert.equal(await holdStatus(hh.hold_id), 'released');
  assert.equal(await holdStatus(fh.hold_id), 'expired');
  await scopedOk(hotel, flight);
});

test('multi-item saga: injected flight failure compensates the confirmed hotel (hotel confirms first)', async () => {
  const hotel = await makeInventory({ total: 2, type: 'room_type' });
  const flight = await makeInventory({ total: 2, type: 'flight_fare' });
  const hh = await holdOn(hotel, 1);
  const fh = await holdOn(flight, 1);

  const r = await book([fh, hh], { simulate: 'flight' }); // request order is irrelevant; hotel is saga step 1
  assert.equal(r.outcome, 'failed');
  assert.equal(r.failure.code, 'sold_out');
  assert.equal(r.booking.items.find((i) => i.entity_type === 'room_type').status, 'compensated');
  assert.equal((await readInventory(hotel.inventory_id)).booked_units, 0);
  assert.equal((await readInventory(hotel.inventory_id)).held_units, 0);
  assert.equal((await readInventory(flight.inventory_id)).held_units, 0);
  await scopedOk(hotel, flight);
});

test('saga: a declined payment compensates every confirmed line', async () => {
  const hotel = await makeInventory({ total: 2, type: 'room_type' });
  const flight = await makeInventory({ total: 2, type: 'flight_fare' });
  const r = await book([await holdOn(hotel, 1), await holdOn(flight, 1)], { simulate: 'payment' });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.failure.code, 'over_budget');
  assert.deepEqual(r.booking.items.map((i) => i.status), ['compensated', 'compensated']);
  assert.equal((await readInventory(hotel.inventory_id)).booked_units, 0);
  assert.equal((await readInventory(flight.inventory_id)).booked_units, 0);
  assert.equal(r.booking.payment.status, 'failed');
  await scopedOk(hotel, flight);
});

test('a failed booking is replayed as failed, and its holds cannot be re-used by mistake', async () => {
  const inv = await makeInventory({ total: 2 });
  const h = await holdOn(inv, 1);
  const args = { userId: user.user_id, idempotencyKey: key(), items: [{ hold_id: h.hold_id }], simulate: 'hotel' };
  const a = await confirmBooking(args);
  const b = await confirmBooking(args);
  assert.equal(a.outcome, 'failed');
  assert.equal(b.outcome, 'failed');
  assert.equal(b.replayed, true);
  assert.equal(a.booking.booking_id, b.booking.booking_id);
  const again = await confirmBooking({ ...args, idempotencyKey: key(), simulate: undefined });
  assert.equal(again.outcome, 'failed', 'a released hold cannot be confirmed by a new attempt');
  assert.equal(again.failure.code, 'hold_expired');
  await scopedOk(inv);
});

test('two different bookings racing for the same hold: exactly one wins, no double consumption', async () => {
  const inv = await makeInventory({ total: 2 });
  const h = await holdOn(inv, 1);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => book([h])),
  );
  assert.equal(results.filter((r) => r.outcome === 'confirmed').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'failed').length, 7);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 1);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 0);
  assert.equal(await holdStatus(h.hold_id), 'confirmed', 'the loser did not release the winner’s hold');
  await scopedOk(inv);
});

test('validation: someone else’s hold is forbidden, an unknown hold is invalid_id and leaves no record', async () => {
  const inv = await makeInventory({ total: 2 });
  const h = await holdOn(inv, 1, other.user_id);
  await assert.rejects(book([h]), { code: 'forbidden' });
  const k = key();
  await assert.rejects(
    confirmBooking({ userId: user.user_id, idempotencyKey: k, items: [{ hold_id: 'hld_nope' }] }),
    { code: 'invalid_id' },
  );
  const n = await pool.query('SELECT count(*)::int n FROM bookings WHERE idempotency_key = $1', [k]);
  assert.equal(n.rows[0].n, 0);
});

test('cancel: units are restocked, payment refunded, nothing deleted; double cancel is a no-op', async () => {
  const inv = await makeInventory({ total: 2 });
  const b = (await book([await holdOn(inv, 2)])).booking;
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 2);
  await assert.rejects(holdOn(inv, 1), { code: 'sold_out' });

  const c1 = await cancelBooking({ bookingId: b.booking_id, userId: user.user_id });
  assert.equal(c1.already, false);
  assert.equal(c1.restocked_units, 2);
  assert.equal(c1.booking.status, 'cancelled');
  assert.ok(c1.booking.cancelled_at);
  assert.equal(c1.booking.items[0].status, 'cancelled');
  assert.equal(c1.booking.payment.status, 'refunded');
  assert.equal(c1.booking.payment.refunded_amount, c1.booking.payment.captured_amount);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 0);

  const c2 = await cancelBooking({ bookingId: b.booking_id, userId: user.user_id });
  assert.equal(c2.already, true);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 0, 'not restocked twice');
  await holdOn(inv, 2); // the restocked units are genuinely sellable again
  await scopedOk(inv);
});

test('cancel: 12 simultaneous cancels restock exactly once', async () => {
  const inv = await makeInventory({ total: 3 });
  const b = (await book([await holdOn(inv, 3)])).booking;
  const results = await Promise.all(
    Array.from({ length: 12 }, () => cancelBooking({ bookingId: b.booking_id, userId: user.user_id })),
  );
  assert.equal(results.filter((r) => !r.already).length, 1);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 0);
  await scopedOk(inv);
});

test('cancel: only confirmed bookings, only by their owner', async () => {
  const inv = await makeInventory({ total: 2 });
  const ok = (await book([await holdOn(inv, 1)])).booking;
  await assert.rejects(cancelBooking({ bookingId: ok.booking_id, userId: other.user_id }), { code: 'forbidden' });
  const failed = (await book([await holdOn(inv, 1)], { simulate: 'hotel' })).booking;
  await assert.rejects(cancelBooking({ bookingId: failed.booking_id, userId: user.user_id }), { code: 'invalid_state' });
  await assert.rejects(cancelBooking({ bookingId: 'bkg_nope' }), { code: 'invalid_id' });
});

test('localised currency: lines are converted at the FX rate and the total carries the requested currency', async () => {
  const inv = await makeInventory({ total: 2, price: '5000.00' });
  const target = inv.currency === 'USD' ? 'EUR' : 'USD';
  const h = await holdOn(inv, 2);
  const b = (await book([h], { currency: target })).booking;
  const fx = await fxContext();
  const unit = convert(fx, '5000.00', inv.currency, target);
  assert.equal(b.currency, target);
  assert.equal(b.items[0].currency, target);
  assert.equal(b.items[0].unit_price, unit);
  assert.equal(b.items[0].line_total, (Number(unit) * 2).toFixed(2));
  assert.match(b.display.total, /\d/);
});

test('rate plan: the plan’s price_delta is applied to the nightly price', async () => {
  const inv = await makeInventory({ total: 2, price: '50000.00' });
  const plan = (
    await pool.query(
      `SELECT rate_plan_id, price_delta::text, currency FROM hotel_rate_plans
        WHERE room_type_id = $1 AND status = 'active' LIMIT 1`,
      [inv.entity_id],
    )
  ).rows[0];
  if (!plan) return; // this random room type has no plan; nothing to assert
  const h = await holdOn(inv, 1);
  const r = await confirmBooking({
    userId: user.user_id,
    idempotencyKey: key(),
    items: [{ hold_id: h.hold_id, rate_plan_id: plan.rate_plan_id }],
  });
  const expected = (Number(50000) + Number(plan.price_delta)).toFixed(2);
  assert.equal(r.booking.items[0].unit_price, expected);
});

test('end to end race: 60 travellers hold-then-book the last 3 units → exactly 3 bookings', async () => {
  const inv = await makeInventory({ total: 3 });
  const run = uniq();
  const traveller = async (i) => {
    const { holds } = await createHold({
      userId: user.user_id,
      items: [{ inventory_id: inv.inventory_id, units: 1 }],
      idempotencyKey: `test_${run}_h${i}`,
      bypassShield: true, // race the database lock itself
    });
    return confirmBooking({
      userId: user.user_id,
      idempotencyKey: `test_${run}_b${i}`,
      items: [{ hold_id: holds[0].hold_id }],
    });
  };
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => traveller(i)));
  const confirmed = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'confirmed');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(confirmed.length, 3);
  assert.ok(rejected.every((r) => r.reason.code === 'sold_out'));
  const row = await readInventory(inv.inventory_id);
  assert.equal(row.booked_units, 3);
  assert.equal(row.held_units, 0);
  await scopedOk(inv);
  assert.equal((await getBooking(confirmed[0].value.booking.booking_id)).status, 'confirmed');
});
