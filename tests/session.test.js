import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../backend/src/db.js';
import { startServer } from '../backend/src/server.js';
import { listPersonas } from '../backend/src/modules/session.js';
import { resetDemo } from '../backend/src/modules/ops.js';
import { makeInventory, readInventory, testUsers, uniq, cleanupTestData, finish } from './helpers.js';

let srv;
let alice;
let bob;
before(async () => {
  await cleanupTestData();
  srv = await startServer({ port: 0, worker: false });
  [alice, bob] = await listPersonas();
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
  return { status: res.status, body: await res.json().catch(() => null) };
};
const as = (u) => ({ 'x-user-id': u.user_id });
const OPERATOR = { 'x-user-id': 'operator' };
const hold = (u, inventory_id, units = 1) =>
  call('POST', '/api/holds', { items: [{ inventory_id, units }], ttl_seconds: 120 }, { ...as(u), 'idempotency-key': `test_${uniq()}`, 'x-bypass-shield': '1' });

test('personas: 10 distinct active travellers, the same list every time, the first two are the INR demo leads', async () => {
  const list = await listPersonas();
  assert.equal(list.length, 10);
  assert.equal(new Set(list.map((p) => p.user_id)).size, 10);
  assert.deepEqual(list.map((p) => p.user_id), (await listPersonas()).map((p) => p.user_id));
  assert.deepEqual(list.slice(0, 2).map((p) => [p.home_currency, p.lead]), [['INR', true], ['INR', true]]);
  assert.equal(new Set(list.slice(2).map((p) => p.home_currency)).size, 8, 'the other eight each have their own home currency');
  const { rows } = await pool.query(`SELECT count(*)::int n FROM users WHERE status = 'active' AND user_id = ANY($1)`, [list.map((p) => p.user_id)]);
  assert.equal(rows[0].n, 10);
  assert.ok(list.every((p) => p.display_name.trim().length > 0));
  const http = await call('GET', '/api/personas');
  assert.equal(http.status, 200);
  assert.equal(http.body.personas.length, 10);
});

test('session: /api/meta reflects who is signed in; an unknown user id is refused', async () => {
  const me = await call('GET', '/api/meta', undefined, as(bob));
  assert.equal(me.body.user.user_id, bob.user_id);
  assert.equal(me.body.role, 'traveller');
  const ops = await call('GET', '/api/meta', undefined, OPERATOR);
  assert.equal(ops.body.role, 'operator');
  const bad = await call('GET', '/api/meta', undefined, { 'x-user-id': 'usr_does_not_exist' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'invalid_session');
});

test('isolation: Bob can neither see, release nor cancel what Alice holds or booked; a body user_id cannot impersonate', async () => {
  const inv = await makeInventory({ total: 3 });
  const h = await hold(alice, inv.inventory_id);
  assert.equal(h.status, 201);
  const holdId = h.body.holds[0].hold_id;

  assert.equal((await call('GET', `/api/holds/${holdId}`, undefined, as(bob))).status, 403);
  assert.equal((await call('POST', `/api/holds/${holdId}/release`, {}, as(bob))).status, 403);
  assert.equal((await call('GET', `/api/holds/${holdId}`, undefined, as(alice))).status, 200);

  const booked = await call('POST', '/api/bookings', { hold_ids: [holdId], payment: { method: 'mock' } }, { ...as(alice), 'idempotency-key': `test_${uniq()}` });
  assert.equal(booked.status, 201);
  const bookingId = booked.body.booking.booking_id;
  assert.equal(booked.body.booking.user_id, alice.user_id);

  assert.equal((await call('GET', `/api/bookings/${bookingId}`, undefined, as(bob))).status, 403);
  assert.equal((await call('POST', `/api/bookings/${bookingId}/cancel`, {}, as(bob))).status, 403);
  const bobList = await call('GET', '/api/bookings', undefined, as(bob));
  assert.ok(!bobList.body.bookings.some((b) => b.booking_id === bookingId));
  const aliceList = await call('GET', '/api/bookings', undefined, as(alice));
  assert.ok(aliceList.body.bookings.some((b) => b.booking_id === bookingId));

  // Bob claiming to be Alice in the body still acts as Bob
  const inv2 = await makeInventory({ total: 2 });
  const spoof = await call('POST', '/api/holds', { user_id: alice.user_id, items: [{ inventory_id: inv2.inventory_id, units: 1 }] }, { ...as(bob), 'idempotency-key': `test_${uniq()}` });
  assert.equal(spoof.body.holds[0].user_id, bob.user_id);

  assert.equal((await call('POST', `/api/bookings/${bookingId}/cancel`, {}, as(alice))).status, 200);
});

test('the scenario: Alice and Bob race for the last unit — exactly one is granted, one is rejected, nothing oversells', async () => {
  const inv = await makeInventory({ total: 1 });
  const [a, b] = await Promise.all([hold(alice, inv.inventory_id), hold(bob, inv.inventory_id)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const loser = a.status === 409 ? alice : bob;
  const row = await readInventory(inv.inventory_id);
  assert.equal(row.held_units, 1);
  assert.ok(row.booked_units + row.held_units <= row.total_units);

  // the operator sees the hold, the rejected attempt with a name on it, and clean invariants
  const s = await call('GET', `/api/ops/summary?inventory_id=${inv.inventory_id}`, undefined, OPERATOR);
  assert.equal(s.status, 200);
  assert.equal(s.body.invariants.ok, true);
  assert.equal(s.body.watched.free_units, 0);
  assert.equal(s.body.rooms[0].inventory_id, inv.inventory_id, 'the room in play leads the picker even though it is now full');
  assert.ok(s.body.activity.some((e) => e.kind === 'hold' && e.status === 'active'));
  assert.ok(s.body.activity.some((e) => e.kind === 'rejected' && e.user.user_id === loser.user_id), 'the loser appears in the feed');
});

test('operations dashboard: login required, travellers refused, the operator gets the counts and 0 violations', async () => {
  const anon = await call('GET', '/api/ops/summary');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'login_required');
  assert.equal((await call('GET', '/api/ops/summary', undefined, as(alice))).status, 403);
  assert.equal((await call('POST', '/api/ops/reset-demo', {}, as(alice))).status, 403);

  const s = await call('GET', '/api/ops/summary', undefined, OPERATOR);
  assert.equal(s.status, 200);
  assert.equal(s.body.invariants.ok, true);
  assert.deepEqual(Object.values(s.body.invariants.counts), [0, 0, 0, 0]);
  for (const k of ['active', 'confirmed']) assert.ok(k in s.body.holds.by_status || k in s.body.bookings.by_status);
  const i = s.body.inventory;
  assert.equal(i.total_units - i.booked_units - i.held_units, i.free_units);
  assert.ok(Array.isArray(s.body.rooms) && s.body.rooms.every((c) => c.hotel_id && c.city));

  const h = await call('POST', '/api/holds', { items: [{ inventory_id: (await makeInventory({ total: 2 })).inventory_id, units: 1 }] }, { ...OPERATOR, 'idempotency-key': `test_${uniq()}` });
  assert.equal(h.status, 403, 'the operator has no traveller identity');
});

test('reset demo: releases the active holds a user made through the app and restocks; seed rows are untouched', async () => {
  const [other] = await testUsers();
  const seedRows = () => pool.query(`SELECT status, count(*)::int n FROM holds WHERE user_id = $1 AND idempotency_key ~ '^h?idem_' GROUP BY status ORDER BY status`, [other.user_id]).then((r) => r.rows);
  const seedBefore = await seedRows();
  const inv = await makeInventory({ total: 2 });
  const out = await call('POST', '/api/holds', { user_id: other.user_id, items: [{ inventory_id: inv.inventory_id, units: 1 }] }, { 'idempotency-key': `test_${uniq()}` });
  assert.equal(out.status, 201);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 1);
  const r = await resetDemo({ userIds: [other.user_id] });
  assert.ok(r.released_holds >= 1);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 0);
  assert.deepEqual(await seedRows(), seedBefore, 'the provided seed holds were not touched');
});

test('GET /api/holds: the traveller sees their own live reservations (however made), described and priced; nobody else does', async () => {
  const [a, b] = [alice, bob];
  const inv = await makeInventory({ total: 3, type: 'room_type', price: '1000.00' });
  const mine = await hold(a, inv.inventory_id, 2);
  assert.equal(mine.status, 201);
  const theirs = await makeInventory({ total: 2, type: 'room_type' });
  assert.equal((await hold(b, theirs.inventory_id, 1)).status, 201);

  const list = await call('GET', '/api/holds', undefined, as(a));
  assert.equal(list.status, 200);
  const row = list.body.holds.find((h) => h.hold_id === mine.body.holds[0].hold_id);
  assert.ok(row, 'own hold is listed');
  assert.equal(row.status, 'active');
  assert.equal(row.units, 2);
  assert.ok(row.seconds_remaining > 0);
  assert.equal(row.inventory.entity_type, 'room_type');
  assert.ok(row.inventory.title.includes('@'), 'described as room @ hotel');
  assert.ok(row.inventory.hotel_city, 'with its city');
  assert.equal(row.price.amount, '2000.00', 'price x units, in the row currency');
  assert.ok(list.body.holds.every((h) => h.user_id === a.user_id), "never anyone else's hold");

  // priced in another currency on request
  const usd = await call('GET', '/api/holds?currency=USD', undefined, as(a));
  assert.equal(usd.body.holds.find((h) => h.hold_id === row.hold_id).price.currency, 'USD');

  // released holds drop off the list
  await call('POST', `/api/holds/${row.hold_id}/release`, {}, as(a));
  const after = await call('GET', '/api/holds', undefined, as(a));
  assert.ok(!after.body.holds.some((h) => h.hold_id === row.hold_id));

  // no session: nothing to list
  const anon = await call('GET', '/api/holds');
  assert.equal(anon.status, 401);
});
