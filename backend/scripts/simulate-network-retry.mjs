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
const runs = Number(arg('runs', 8));
const units = Number(arg('units', 1));
let inventoryId = arg('inventory');

if (!inventoryId) {
  const r = await fetch(`${baseUrl}/api/inventory/contended?limit=1`).then((res) => res.json());
  inventoryId = r.inventory?.[0]?.inventory_id;
  if (!inventoryId) {
    console.error('no contended inventory row found — pass --inventory explicitly');
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
console.log(`target: ${inventoryId}  (${before.total_units} total, ${before.total_units - before.booked_units - before.held_units} free)`);
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
