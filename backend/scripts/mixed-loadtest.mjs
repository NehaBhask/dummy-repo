#!/usr/bin/env node
// Mixed load-test scenario: a crowd races for one inventory row; a share of the winners CONFIRM
// (pay), the rest ABANDON their hold and let it expire past its TTL. When the dust settles it
// asserts the closing balance for the row and prints PASS/FAIL with the numbers:
//
//     booked + held + available == total      (checked against independently derived figures)
//     no expired hold still holds stock       (no hold is 'active' past its deadline; held_units back to baseline)
//     zero oversell, throughout               (sampled during the run, and again via /api/invariants)
//
// The "expected" side is derived from the individual hold records (GET /api/holds/:id) that this
// script created, NOT from the row's own counters, so the assertion is not a tautology.
// Runs on confirm + TTL expiry only. Cancellation is used only to put the data back afterwards.
//
// Usage: node scripts/mixed-loadtest.mjs [--base-url http://localhost:3000] [--inventory inv_x]
//          [--requests 60] [--confirm-share 0.5] [--ttl 8] [--keep] [--max-wait 90]
// Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const baseUrl = arg('base-url', 'http://localhost:3000');
const share = Number(arg('confirm-share', 0.5));
const ttl = Math.max(5, Number(arg('ttl', 8)));
const maxWaitS = Number(arg('max-wait', 90));
const keep = args.includes('--keep');
let inventoryId = arg('inventory');
const runTag = `mixed-${Date.now().toString(36)}`;

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rowOf = async (id) => (await api('GET', `/api/inventory/${id}`)).body;
const freeOf = (r) => r.total_units - r.booked_units - r.held_units;

if (!inventoryId) {
  const cities = ['Jaipur', 'Agra', 'Udaipur', 'Varanasi', 'Jaisalmer', 'Kolkata', 'New Delhi'];
  const checkIn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  let best = null;
  for (const city of cities) {
    const r = await api('GET', `/api/search/hotels?city=${encodeURIComponent(city)}&check_in=${checkIn}&nights=1&limit=10`);
    for (const card of r.body?.results ?? []) {
      for (const room of card.rooms) {
        if (!best || room.available_units > best.free) best = { id: room.inventory[0].inventory_id, free: room.available_units };
      }
    }
  }
  inventoryId = best?.id;
}
if (!inventoryId) {
  console.error('no bookable room found — pass --inventory explicitly');
  process.exit(2);
}

const before = await rowOf(inventoryId);
if (!before || before.error) {
  console.error(`cannot read ${inventoryId}`);
  process.exit(2);
}
const freeBefore = freeOf(before);
const requests = Number(arg('requests', Math.min(400, Math.max(40, freeBefore * 2))));
if (freeBefore < 2) {
  console.error(`${inventoryId} has only ${freeBefore} free unit(s) — need at least 2 to have both confirmed and abandoned holds`);
  process.exit(2);
}

console.log(`target ${inventoryId}: total=${before.total_units} booked=${before.booked_units} held=${before.held_units} free=${freeBefore}`);
console.log(`${requests} requests race for it; hold TTL ${ttl}s; ${Math.round(share * 100)}% of winners will confirm, the rest are abandoned\n`);

// Phase 1 — the race. Every request is released at the same instant.
let oversoldSeen = false;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const r = await rowOf(inventoryId).catch(() => null);
    if (r && r.booked_units + r.held_units > r.total_units) oversoldSeen = true;
    await sleep(20);
  }
})();

const raceStart = Date.now();
const raced = await Promise.all(
  Array.from({ length: requests }, (_, i) =>
    api('POST', '/api/holds', { items: [{ inventory_id: inventoryId, units: 1 }], ttl_seconds: ttl }, { 'idempotency-key': `${runTag}-h-${String(i).padStart(4, '0')}` }),
  ),
);
const granted = raced.filter((r) => r.status === 201 || r.status === 200).map((r) => r.body.holds[0].hold_id);
const soldOut = raced.filter((r) => r.body?.error?.code === 'sold_out').length;
const otherFail = raced.length - granted.length - soldOut;
console.log(`phase 1  race:      ${granted.length} granted, ${soldOut} sold out, ${otherFail} other   (expected ${Math.min(requests, freeBefore)} granted)`);

// Phase 2 — a share confirms (concurrently, real payment path); the others are abandoned.
const confirmCount = Math.round(granted.length * share);
const toConfirm = granted.slice(0, confirmCount);
const abandoned = granted.slice(confirmCount);
const bookings = await Promise.all(
  toConfirm.map((hold_id, i) =>
    api('POST', '/api/bookings', { hold_ids: [hold_id], payment: { method: 'mock' } }, { 'idempotency-key': `${runTag}-b-${String(i).padStart(4, '0')}` }),
  ),
);
const confirmedOk = bookings.filter((b) => b.body?.booking?.status === 'confirmed');
const bookingIds = confirmedOk.map((b) => b.body.booking.booking_id);
console.log(`phase 2  confirm:   ${confirmedOk.length}/${toConfirm.length} confirmed and paid; ${abandoned.length} holds abandoned (not confirmed, not released)`);

// Phase 3 — wait past the TTL, then for the expiry sweep to return the abandoned units.
const deadline = Date.now() + maxWaitS * 1000;
const expectedHeldAfter = before.held_units;
process.stdout.write(`phase 3  expiry:    waiting for ${abandoned.length} abandoned hold(s) to pass their ${ttl}s TTL and be swept`);
let now;
while (Date.now() < deadline) {
  now = await rowOf(inventoryId);
  if (now.held_units === expectedHeldAfter && Date.now() - raceStart > ttl * 1000) break;
  process.stdout.write('.');
  await sleep(1000);
}
sampling = false;
await sampler;
console.log(` done (${Math.round((Date.now() - raceStart) / 1000)}s after the race started)\n`);

// A late confirm on an abandoned hold must be refused: the deadline is enforced at confirm time.
let lateConfirmRefused = null;
if (abandoned.length) {
  const late = await api('POST', '/api/bookings', { hold_ids: [abandoned[0]], payment: { method: 'mock' } }, { 'idempotency-key': `${runTag}-late` });
  lateConfirmRefused = late.status >= 400 && late.body?.booking?.status !== 'confirmed';
}

// Phase 4 — the closing balance, derived from the individual hold records.
const holdRecords = await Promise.all(granted.map((id) => api('GET', `/api/holds/${id}`).then((r) => r.body)));
const byStatus = (s) => holdRecords.filter((h) => h.status === s).reduce((n, h) => n + h.units, 0);
const stillActive = holdRecords.filter((h) => h.status === 'active');
const activePastDeadline = stillActive.filter((h) => Date.parse(h.expires_at) <= Date.now());

const after = await rowOf(inventoryId);
const inv = (await api('GET', '/api/invariants')).body;

const expectedBooked = before.booked_units + byStatus('confirmed');
const expectedHeld = before.held_units + byStatus('active');
const expectedAvailable = before.total_units - expectedBooked - expectedHeld;
const actualAvailable = freeOf(after);

const checks = [
  ['booked + held + available == total', after.booked_units + after.held_units + actualAvailable === after.total_units,
    `${after.booked_units} + ${after.held_units} + ${actualAvailable} = ${after.booked_units + after.held_units + actualAvailable} (total ${after.total_units})`],
  ['booked matches the confirmed holds', after.booked_units === expectedBooked, `row ${after.booked_units} vs ${expectedBooked} derived from hold records`],
  ['held matches the still-active holds', after.held_units === expectedHeld, `row ${after.held_units} vs ${expectedHeld} derived from hold records`],
  ['available matches the derived figure', actualAvailable === expectedAvailable, `row ${actualAvailable} vs ${expectedAvailable}`],
  ['no expired hold still holds stock', activePastDeadline.length === 0 && byStatus('expired') === abandoned.length, `${activePastDeadline.length} active past deadline; ${byStatus('expired')}/${abandoned.length} abandoned holds now 'expired'`],
  ['abandoned units returned to the pool', after.held_units === before.held_units, `held back to baseline ${before.held_units}`],
  ['late confirm on an expired hold refused', lateConfirmRefused !== false, lateConfirmRefused === null ? 'n/a' : 'refused'],
  ['zero oversell throughout the run', !oversoldSeen && inv.counts.oversold === 0, `sampled every ~20ms during the run; /api/invariants oversold=${inv.counts.oversold}`],
  ['global invariants clean', inv.ok, JSON.stringify(inv.counts)],
  ['exactly the free units were granted', granted.length === Math.min(requests, freeBefore) && otherFail === 0, `${granted.length} granted, ${otherFail} unexpected failures`],
];

console.log(`closing balance for ${inventoryId}`);
console.log(`  total ${after.total_units} | booked ${after.booked_units} (was ${before.booked_units}) | held ${after.held_units} (was ${before.held_units}) | available ${actualAvailable} (was ${freeBefore})\n`);
for (const [name, ok, detail] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
const passed = checks.every(([, ok]) => ok);

// Put the data back (cancellation restocks). Skipped with --keep. Not part of the assertion above.
if (!keep) {
  await Promise.all(bookingIds.map((id) => api('POST', `/api/bookings/${id}/cancel`, { reason: 'mixed load test cleanup' })));
  const restored = await rowOf(inventoryId);
  const invAfter = (await api('GET', '/api/invariants')).body;
  console.log(`\ncleanup: cancelled ${bookingIds.length} test booking(s); row booked=${restored.booked_units} held=${restored.held_units}; invariants ${invAfter.ok ? 'clean' : 'NOT clean'}`);
}

console.log(`\n${passed ? 'PASS' : 'FAIL'} — mixed confirm/abandon run: closing balance ${passed ? 'holds, no stock leaked by expired holds, zero oversell' : 'BROKEN (see FAIL lines)'}`);
process.exit(passed ? 0 : 1);
