import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { startServer } from '../src/server.js';
import { runLoadTest } from '../src/modules/loadtest/engine.js';
import { checkInvariants } from '../src/modules/invariants.js';
import { makeInventory, readInventory, uniq, cleanupTestData, finish } from './helpers.js';

let srv;
before(async () => {
  await cleanupTestData();
  srv = await startServer({ port: 0, worker: false });
});
after(async () => {
  await srv.close();
  await finish();
});

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(srv.baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

test('HTTP: hold → confirm → replay → cancel, with the documented status codes and headers', async () => {
  const inv = await makeInventory({ total: 3, price: '2000.00' });
  const k = `test_${uniq()}`;
  const item = { inventory_id: inv.inventory_id, units: 2 };

  const h1 = await call('POST', '/api/holds', { items: [item] }, { 'Idempotency-Key': `${k}_h` });
  assert.equal(h1.status, 201);
  assert.equal(h1.headers.get('idempotent-replayed'), 'false');
  const h2 = await call('POST', '/api/holds', { items: [item] }, { 'Idempotency-Key': `${k}_h` });
  assert.equal(h2.status, 200);
  assert.equal(h2.headers.get('idempotent-replayed'), 'true');
  assert.equal(h2.body.holds[0].hold_id, h1.body.holds[0].hold_id);

  const soldOut = await call('POST', '/api/holds', { items: [{ ...item, units: 2 }] }, { 'Idempotency-Key': `${k}_h3` });
  assert.equal(soldOut.status, 409);
  assert.equal(soldOut.body.error.code, 'sold_out');

  const b = await call('POST', '/api/bookings', { hold_ids: [h1.body.holds[0].hold_id] }, { 'Idempotency-Key': `${k}_b` });
  assert.equal(b.status, 201);
  assert.equal(b.body.booking.status, 'confirmed');
  const b2 = await call('POST', '/api/bookings', { hold_ids: [h1.body.holds[0].hold_id] }, { 'Idempotency-Key': `${k}_b` });
  assert.equal(b2.status, 200);
  assert.equal(b2.body.booking.booking_id, b.body.booking.booking_id);

  const c = await call('POST', `/api/bookings/${b.body.booking.booking_id}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(c.body.restocked_units, 2);
  assert.equal((await readInventory(inv.inventory_id)).booked_units, 0);
});

test('HTTP: saga failure returns the cause with rolled_back and a localised (Hindi) message', async () => {
  const hotel = await makeInventory({ total: 2, type: 'room_type' });
  const flight = await makeInventory({ total: 2, type: 'flight_fare' });
  const k = `test_${uniq()}`;
  const h = await call('POST', '/api/holds', { items: [{ inventory_id: hotel.inventory_id }] }, { 'Idempotency-Key': `${k}_a` });
  const f = await call('POST', '/api/holds', { items: [{ inventory_id: flight.inventory_id }] }, { 'Idempotency-Key': `${k}_b` });
  const r = await call(
    'POST',
    '/api/bookings',
    { hold_ids: [h.body.holds[0].hold_id, f.body.holds[0].hold_id], simulate_failure: 'flight' },
    { 'Idempotency-Key': `${k}_c`, 'Accept-Language': 'hi' },
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.error.rolled_back, true);
  assert.match(r.body.error.message, /[ऀ-ॿ]/, 'message is in Devanagari');
  assert.equal(r.body.booking.status, 'failed');
  assert.ok(r.body.booking.items.every((i) => i.status === 'compensated'));

  const declined = await call(
    'POST',
    '/api/bookings',
    { hold_ids: [(await call('POST', '/api/holds', { items: [{ inventory_id: hotel.inventory_id }] }, { 'Idempotency-Key': `${k}_d` })).body.holds[0].hold_id], simulate_failure: 'payment' },
    { 'Idempotency-Key': `${k}_e` },
  );
  assert.equal(declined.status, 402, 'declined payment maps to 402');
});

test('HTTP: bad input is a 400 with field-level details, never a 500', async () => {
  const noKey = await call('POST', '/api/holds', { items: [{ inventory_id: 'inv_x' }] });
  assert.equal(noKey.status, 400);
  const badBody = await call('POST', '/api/holds', { items: [{ inventory_id: 'inv_x', units: 0 }] }, { 'Idempotency-Key': 'abcdefgh' });
  assert.equal(badBody.status, 400);
  const badJson = await fetch(`${srv.baseUrl}/api/holds`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'abcdefgh' }, body: '{nope' });
  assert.equal(badJson.status, 400);
  assert.equal((await call('POST', '/api/holds', { items: [{ inventory_id: 'inv_nope' }] }, { 'Idempotency-Key': 'abcdefgh' })).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('HTTP: search only returns rooms that are genuinely available for every night', async () => {
  const res = await call('GET', '/api/search/hotels?city=Jaipur&check_in=2026-10-10&nights=2&rooms=2&currency=USD');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 0);
  for (const card of res.body.results) {
    for (const room of card.rooms) {
      assert.ok(room.available_units >= 2, 'every returned room has >= the requested units free');
      assert.equal(room.inventory.length, 2);
      assert.equal(room.from_price.currency, 'USD');
      const rows = (await pool.query(
        `SELECT min(total_units - booked_units - held_units) AS f FROM inventory_calendar WHERE inventory_id = ANY($1)`,
        [room.inventory.map((i) => i.inventory_id)],
      )).rows[0];
      assert.ok(rows.f >= 2, 'grounded in inventory_calendar');
    }
  }
  const cheap = await call('GET', '/api/search/hotels?city=Jaipur&check_in=2026-10-10&max_price=0.01&currency=USD');
  assert.equal(cheap.body.total, 0, 'price filter is applied in the requested currency');
});

test('load test (API mode): 300 concurrent requests for the last 3 units → exactly 3, verdict passes', async () => {
  const inv = await makeInventory({ total: 3 });
  const run = await runLoadTest({ inventory_id: inv.inventory_id, concurrent_requests: 300 }, { baseUrl: srv.baseUrl });
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.successes, 3);
  assert.equal(run.summary.sold_out, 297);
  assert.equal(run.summary.errors, 0);
  assert.equal(run.verdict.passed, true, JSON.stringify(run.verdict.checks));
  assert.equal(run.verdict.checks.db_check_never_fired, true, 'zero DB-CHECK rejections');
  assert.equal(run.cleanup.restored_to_initial, true);
  assert.ok(run.summary.p99_ms >= run.summary.p50_ms);

  const persisted = (await pool.query('SELECT successes, sold_out, oversold, p99_ms FROM load_test_runs WHERE run_id = $1', [run.run_id])).rows[0];
  assert.equal(persisted.successes, 3);
  assert.equal(persisted.oversold, false);
  const n = (await pool.query('SELECT count(*)::int n FROM load_test_results WHERE run_id = $1', [run.run_id])).rows[0].n;
  assert.equal(n, 300);
});

test('load test: every request sent 3× with the same idempotency key never double-books', async () => {
  const inv = await makeInventory({ total: 5 });
  const run = await runLoadTest(
    { inventory_id: inv.inventory_id, concurrent_requests: 40, duplicate_factor: 3, units_per_request: 1 },
    { baseUrl: srv.baseUrl },
  );
  assert.equal(run.summary.successes, 5, '5 free units, 5 distinct requests granted (not 15)');
  assert.equal(run.verdict.checks.no_request_granted_twice, true);
  assert.equal(run.verdict.checks.counters_reconcile, true);
  assert.equal(run.verdict.passed, true, JSON.stringify(run.verdict.checks));
  assert.equal(run.verdict.detail.duplicate_attempts_sent, 80);
});

test('load test (direct mode) and multi-unit requests', async () => {
  const inv = await makeInventory({ total: 7 });
  const run = await runLoadTest(
    { inventory_id: inv.inventory_id, concurrent_requests: 100, units_per_request: 2, mode: 'direct' },
    { baseUrl: srv.baseUrl },
  );
  assert.equal(run.summary.successes, 3, 'floor(7 / 2) two-unit holds');
  assert.equal(run.verdict.passed, true, JSON.stringify(run.verdict.checks));
});

test('the whole database still satisfies every invariant after all of the above', async () => {
  const r = await checkInvariants();
  assert.ok(r.ok, JSON.stringify(r));
});
