import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../backend/src/db.js';
import { metrics, fromPgError } from '../backend/src/errors.js';
import { createHold, releaseHold, expireHolds, getHold } from '../backend/src/modules/booking/holds.js';
import { checkInvariants } from '../backend/src/modules/invariants.js';
import { makeInventory, readInventory, testUsers, uniq, cleanupTestData, finish } from './helpers.js';

let user;
before(async () => {
  await cleanupTestData();
  [user] = await testUsers();
});
after(finish);

const hold = (inventory_id, units, key, extra = {}) =>
  // bypassShield: race tests must reach Postgres' row lock; only the shield tests below opt back in.
  createHold({ userId: user.user_id, items: [{ inventory_id, units }], idempotencyKey: key, bypassShield: true, ...extra });

test('200 concurrent requests for the last 3 units: exactly 3 succeed, 197 sold out', async () => {
  const inv = await makeInventory({ total: 3 });
  const run = uniq();
  const netBefore = metrics.safetyNetHits;
  // Errors reach callers raw; translate like the HTTP layer does so a CHECK violation is counted.
  const results = await Promise.allSettled(
    Array.from({ length: 200 }, (_, i) =>
      hold(inv.inventory_id, 1, `test_${run}_${i}`).catch((e) => {
        throw fromPgError(e);
      }),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 3, 'exactly the 3 free units are granted');
  assert.ok(rejected.every((r) => r.reason.code === 'sold_out'), 'every other request is a clean sold_out');
  assert.equal(rejected.length, 197);

  const row = await readInventory(inv.inventory_id);
  assert.equal(row.held_units, 3);
  assert.equal(row.booked_units, 0);
  assert.equal(metrics.safetyNetHits, netBefore, 'the DB CHECK never had to fire: the row lock did the work');
  const inv2 = await checkInvariants(pool, { inventoryIds: [inv.inventory_id] });
  assert.ok(inv2.ok, JSON.stringify(inv2.counts));
});

test('multi-unit requests never overshoot: 2-unit holds against 5 free grant exactly 2', async () => {
  const inv = await makeInventory({ total: 5 });
  const run = uniq();
  const results = await Promise.allSettled(
    Array.from({ length: 60 }, (_, i) => hold(inv.inventory_id, 2, `test_${run}_${i}`)),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 4);
});

test('idempotency: sequential retry returns the same hold and consumes units once', async () => {
  const inv = await makeInventory({ total: 5 });
  const key = `test_${uniq()}`;
  const a = await hold(inv.inventory_id, 2, key);
  const b = await hold(inv.inventory_id, 2, key);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(a.holds[0].hold_id, b.holds[0].hold_id);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 2);
});

test('a retry of the request that took the LAST unit is a replay, not sold_out', async () => {
  const inv = await makeInventory({ total: 1 });
  const key = `test_${uniq()}`;
  const a = await hold(inv.inventory_id, 1, key);
  const b = await hold(inv.inventory_id, 1, key); // row is now full; fast-reject must not shadow the replay
  assert.equal(b.replayed, true);
  assert.equal(b.holds[0].hold_id, a.holds[0].hold_id);
  await assert.rejects(hold(inv.inventory_id, 1, `test_${uniq()}`), { code: 'sold_out' }, 'a different key is rejected');
});

test('idempotency: 25 simultaneous retries of one key create exactly one hold', async () => {
  const inv = await makeInventory({ total: 5 });
  const key = `test_${uniq()}`;
  const results = await Promise.all(Array.from({ length: 25 }, () => hold(inv.inventory_id, 1, key)));
  assert.equal(new Set(results.map((r) => r.holds[0].hold_id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1, 'exactly one request did the work');
  assert.equal((await readInventory(inv.inventory_id)).held_units, 1);
  const { rows } = await pool.query('SELECT count(*)::int n FROM holds WHERE inventory_id = $1', [inv.inventory_id]);
  assert.equal(rows[0].n, 1);
});

test('idempotency: reusing a key for a different request is refused, not answered with the wrong hold', async () => {
  const inv = await makeInventory({ total: 5 });
  const key = `test_${uniq()}`;
  await hold(inv.inventory_id, 1, key);
  await assert.rejects(hold(inv.inventory_id, 2, key), { code: 'idempotency_conflict' });
  const other = await makeInventory({ total: 5 });
  await assert.rejects(hold(other.inventory_id, 1, key), { code: 'idempotency_conflict' });
  assert.equal((await readInventory(other.inventory_id)).held_units, 0);
});

test('a multi-row hold is atomic: if one night is sold out, no night is held', async () => {
  const a = await makeInventory({ total: 2 });
  const b = await makeInventory({ total: 1 });
  await hold(b.inventory_id, 1, `test_${uniq()}`); // b is now full
  await assert.rejects(
    createHold({
      userId: user.user_id,
      idempotencyKey: `test_${uniq()}`,
      items: [
        { inventory_id: a.inventory_id, units: 1 },
        { inventory_id: b.inventory_id, units: 1 },
      ],
    }),
    { code: 'sold_out' },
  );
  assert.equal((await readInventory(a.inventory_id)).held_units, 0, 'the free row was not left half-held');
});

test('a trip held in one request shares one deadline across every row (hotel + flight expire together)', async () => {
  const hotel = await makeInventory({ total: 3 });
  const flight = await makeInventory({ total: 3 });
  const out = await createHold({
    userId: user.user_id,
    idempotencyKey: `test_${uniq()}`,
    ttlSeconds: 120,
    items: [
      { inventory_id: flight.inventory_id, units: 1 },
      { inventory_id: hotel.inventory_id, units: 1 },
    ],
  });
  assert.equal(out.holds.length, 2);
  assert.equal(new Set(out.holds.map((h) => new Date(h.expires_at).getTime())).size, 1, 'one expires_at for the whole trip');
  // callers match holds to items by inventory_id (never by position): each requested row appears exactly once
  assert.deepEqual(out.holds.map((h) => h.inventory_id).sort(), [hotel.inventory_id, flight.inventory_id].sort());
});

test('no deadlock: opposite-order multi-row holds racing on the same rows', async () => {
  const a = await makeInventory({ total: 100 }); // room for all 80 requests: any failure is a deadlock
  const b = await makeInventory({ total: 100 });
  const run = uniq();
  const req = (i) => {
    // Callers list the rows in opposite orders; the service must lock them in one fixed order.
    const items = [
      { inventory_id: a.inventory_id, units: 1 },
      { inventory_id: b.inventory_id, units: 1 },
    ];
    if (i % 2) items.reverse();
    return createHold({ userId: user.user_id, items, idempotencyKey: `test_${run}_${i}` });
  };
  const results = await Promise.allSettled(Array.from({ length: 80 }, (_, i) => req(i)));
  const failures = results.filter((r) => r.status === 'rejected');
  assert.equal(failures.length, 0, failures.map((f) => f.reason?.message).join('; '));
  assert.equal((await readInventory(a.inventory_id)).held_units, 80);
  assert.equal((await readInventory(b.inventory_id)).held_units, 80);
});

test('release returns units to the pool and is idempotent', async () => {
  const inv = await makeInventory({ total: 2 });
  const { holds } = await hold(inv.inventory_id, 2, `test_${uniq()}`);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 2);
  const r1 = await releaseHold({ holdId: holds[0].hold_id, userId: user.user_id });
  const r2 = await releaseHold({ holdId: holds[0].hold_id, userId: user.user_id });
  assert.equal(r1.status, 'released');
  assert.equal(r2.status, 'released');
  assert.equal((await readInventory(inv.inventory_id)).held_units, 0, 'restocked once, not twice');
});

test('expiry: a hold past its deadline is expired by the worker and its units restocked', async () => {
  const inv = await makeInventory({ total: 2 });
  const { holds } = await hold(inv.inventory_id, 2, `test_${uniq()}`, { ttlSeconds: 5 });
  assert.equal(
    (await expireHolds({ inventoryIds: [inv.inventory_id] })).expired,
    0,
    'not expired before its deadline',
  );
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [holds[0].hold_id]);
  const r = await expireHolds({ inventoryIds: [inv.inventory_id] });
  assert.equal(r.expired, 1);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 0);
  const h = await getHold(holds[0].hold_id);
  assert.equal(h.status, 'expired');
  assert.ok(h.released_at, 'expired holds carry released_at, like the seed data');
  assert.equal((await expireHolds({ inventoryIds: [inv.inventory_id] })).expired, 0, 'second sweep is a no-op');
  // and the freed units can be sold again
  await hold(inv.inventory_id, 2, `test_${uniq()}`);
});

test('a hold on an unknown inventory id is invalid_id, not a crash', async () => {
  await assert.rejects(hold('inv_doesnotexist', 1, `test_${uniq()}`), { code: 'invalid_id' });
});

const SHIELD = { bypassShield: false };

test('sold-out memory never blocks a real free-up: release / expiry / cancel make units bookable immediately', async () => {
  const inv = await makeInventory({ total: 1 });
  const { holds } = await hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD);
  await assert.rejects(hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD), { code: 'sold_out' }); // row is now remembered as full
  await assert.rejects(hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD), { code: 'sold_out' }); // ...and answered from memory
  await releaseHold({ holdId: holds[0].hold_id, userId: user.user_id });
  const again = await hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD); // no waiting for the memory to age out
  assert.equal(again.replayed, false);

  await assert.rejects(hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD), { code: 'sold_out' });
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [again.holds[0].hold_id]);
  await expireHolds({ inventoryIds: [inv.inventory_id] });
  await hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD);
});

test('sold-out memory only rejects what cannot fit: a smaller request still succeeds', async () => {
  const inv = await makeInventory({ total: 3 });
  await hold(inv.inventory_id, 2, `test_${uniq()}`, SHIELD); // 1 left
  await assert.rejects(hold(inv.inventory_id, 2, `test_${uniq()}`, SHIELD), { code: 'sold_out' }); // remembers "1 available"
  const one = await hold(inv.inventory_id, 1, `test_${uniq()}`, SHIELD); // 1 fits and must be granted
  assert.equal(one.replayed, false);
  assert.equal((await readInventory(inv.inventory_id)).held_units, 3);
});
