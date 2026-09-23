 #!/usr/bin/env node
// Simulates the exact scenario idempotency exists to protect against: a client sends a booking
// request, the SERVER receives and fully processes it, but the RESPONSE never reaches the client
// (dropped connection, timeout, flaky mobile data) — so the client, not knowing whether it
// worked, safely retries with the same idempotency key.
//
// Different from distributed-idempotency-test.yml (many separate machines racing the SAME key
// concurrently, all at once). This is the sequential, single-client case: "did my request even
// go through?" — followed by a retry, the way a real app is supposed to behave on a timeout.
//
// Honesty note: we can't literally sever a TCP connection mid-flight without OS-level tooling
// (tc netem / toxiproxy). This approximates it with a short CLIENT-SIDE abort: the request is
// fully sent, but the client gives up waiting before the server would normally answer. Whether
// that abort actually lands *while the server is still working* (the interesting case) or the
// server happens to finish first (a boring, still-successful, still-safe case) depends on real
// timing that a script can't perfectly control — so every run reports plainly which one happened,
// rather than pretending otherwise. At the end it checks the ONE thing that must always be true
// regardless: exactly one hold created per run, never two.
//
// Usage: node simulate-network-retry.mjs [--base-url http://localhost:3000] [--inventory inv_x]
//                                        [--abort-ms 30] [--runs 8] [--units 1]
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

const baseUrl = arg('base-url', 'http://localhost:3000');
const abortMs = Number(arg('abort-ms', 30));
const requestedRuns = Number(arg('runs', 8));
const runsExplicit = args.includes('--runs');
const units = Number(arg('units', 1));
let inventoryId = arg('inventory');
const inventoryExplicit = Boolean(inventoryId);

if (!inventoryId) {
  // This test creates `runs` SEPARATE holds (one per run) — it needs a room with plenty of spare
  // capacity, the opposite of what /api/inventory/contended returns (that endpoint is built to
  // find the SCARCEST rows in the whole dataset for the race tests; reusing it here always landed
  // on a 1-unit room, no matter how it was sorted). Search a few known-bookable cities instead and
  // pick whichever room currently has the most free units.
  const CITIES = ['Jaipur', 'Agra', 'Udaipur', 'Varanasi', 'Jaisalmer', 'Kolkata', 'New Delhi'];
  const checkIn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10); // a week out, inside the seeded window
  let best = null;
  for (const city of CITIES) {
    const r = await fetch(`${baseUrl}/api/search/hotels?city=${encodeURIComponent(city)}&check_in=${checkIn}&nights=1&limit=10`).then((res) => res.json());
    for (const card of r.results ?? []) {
      for (const room of card.rooms) {
        if (!best || room.available_units > best.free) best = { inventory_id: room.inventory[0].inventory_id, free: room.available_units };
      }
    }
  }
  inventoryId = best?.inventory_id;
  if (!inventoryId) {
    console.error('no bookable room found across the usual cities — pass --inventory explicitly');
    process.exit(2);
  }
}

async function attempt(key, { abort }) {
  const start = performance.now();
  const controller = abort ? new AbortController() : undefined;
  const timer = abort ? setTimeout(() => controller.abort(), abortMs) : null;
  try {
    const res = await fetch(`${baseUrl}/api/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ items: [{ inventory_id: inventoryId, units }], ttl_seconds: 120 }),
      signal: controller?.signal,
    });
    const body = await res.json().catch(() => null);
    return {
      outcome: res.ok ? 'ok' : 'error',
      status: res.status,
      hold_id: body?.holds?.[0]?.hold_id ?? null,
      replayed: body?.replayed ?? null,
      code: body?.error?.code,
      ms: performance.now() - start,
    };
  } catch (err) {
    return { outcome: 'client_gave_up', reason: err.name, ms: performance.now() - start };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const before = await fetch(`${baseUrl}/api/inventory/${inventoryId}`).then((r) => r.json());
const free = before.total_units - before.booked_units - before.held_units;
console.log(`target: ${inventoryId}  (${before.total_units} total, ${free} free)`);

// This test needs `runs` SEPARATE holds worth of capacity (it is not racing everyone for one
// unit) — checked up front so a too-small row fails clearly, before wasting requests, instead of
// producing a wall of "sold_out" that looks like a broken guarantee but is just an undersized target.
let runs = requestedRuns;
if (free < requestedRuns) {
  if (runsExplicit || inventoryExplicit) {
    console.error(
      `\n${inventoryId} only has ${free} free unit(s), but --runs ${requestedRuns} needs one hold each.\n` +
        `Lower --runs to ${free} or fewer, or point --inventory at a room with more free units.`,
    );
    process.exit(2);
  }
  runs = Math.max(1, free);
  console.log(`(only ${free} free here, and --runs wasn't set explicitly — running ${runs} instead of the default ${requestedRuns})`);
}
console.log(`simulating a dropped response with a ${abortMs}ms client-side abort, then a normal retry — ${runs} run(s)\n`);

let caughtMidFlight = 0;
let problems = 0;
const holdIds = [];

for (let i = 0; i < runs; i++) {
  const key = `netfail-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
  const first = await attempt(key, { abort: true });
  const midFlight = first.outcome === 'client_gave_up';
  if (midFlight) caughtMidFlight++;
  console.log(
    `[run ${i}] first attempt: ${midFlight ? `client gave up waiting after ${abortMs}ms (simulated dropped response)` : `actually completed in ${first.ms.toFixed(0)}ms (too fast to interrupt this time — still a valid, if less dramatic, run)`}`,
  );

  await sleep(75); // give the server a moment to finish, the way a real retry would after a timeout
  const retry = await attempt(key, { abort: false });
  const via = retry.replayed === true ? 'REPLAY (proves the first request had already completed server-side)'
    : retry.replayed === false ? 'ORIGINAL WRITE (the first request had not been recorded yet — retry did the work)'
    : `unexpected: ${retry.outcome} ${retry.code ?? ''}`;
  console.log(`         retry: hold_id=${retry.hold_id ?? 'none'}  ${via}`);

  if (retry.outcome !== 'ok' || !retry.hold_id) {
    problems++;
    console.log('         PROBLEM: retry did not return a usable hold');
  } else {
    holdIds.push(retry.hold_id);
  }
}

const after = await fetch(`${baseUrl}/api/inventory/${inventoryId}`).then((r) => r.json());
const consumed = (after.held_units + after.booked_units) - (before.held_units + before.booked_units);

console.log(`\n${caughtMidFlight}/${runs} run(s) genuinely caught the client mid-flight (the interesting case — server still working when we gave up)`);
console.log(`${holdIds.length} distinct hold(s) created for ${runs} runs (must be exactly ${runs} — one per run, never two)`);
console.log(`units consumed: ${consumed} (must be exactly ${runs * units})`);

const inv = await fetch(`${baseUrl}/api/invariants`).then((r) => r.json());
console.log(`GET /api/invariants ->`, inv.counts);

if (new Set(holdIds).size !== runs) problems++;
if (consumed !== runs * units) problems++;
if (!inv.ok) problems++;

// Release everything this script created — restock for next time.
for (const id of holdIds) {
  await fetch(`${baseUrl}/api/holds/${id}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}
console.log(`released ${holdIds.length} hold(s)`);

if (problems) {
  console.error(`\nFAILED (${problems} problem(s) above)`);
  process.exit(1);
}
console.log(`\nSAFE UNDER SIMULATED NETWORK FAILURE: every retry after a dropped response returned the correct single hold, never a duplicate.`);
