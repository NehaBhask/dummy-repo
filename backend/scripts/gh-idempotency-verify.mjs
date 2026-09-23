#!/usr/bin/env node
// Combines every runner's result.json and checks the ONE thing that actually matters: across
// every attempt, from every machine, using the identical idempotency key, was there ever more
// than one distinct hold_id? If idempotency holds, the answer is exactly one — no matter how many
// of the (attempts x runners) requests raced for it. Also confirms the inventory row only ever
// paid for ONE hold's worth of units, not one per attempt, then restocks it.
//
// Usage: node gh-idempotency-verify.mjs --base-url <url> --inventory <id> --units 1
//                                        --initial-free 3 --results-dir results [--release]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const baseUrl = arg('base-url');
const inventoryId = arg('inventory');
const units = Number(arg('units', 1));
const initialFree = Number(arg('initial-free'));
const resultsDir = arg('results-dir');
const doRelease = flag('release');

function findResultFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out = out.concat(findResultFiles(p));
    else if (entry === 'result.json') out.push(p);
  }
  return out;
}

const runs = findResultFiles(resultsDir).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const totalAttempts = runs.reduce((a, r) => a + r.attempts, 0);
const totalOk = runs.reduce((a, r) => a + r.ok, 0);
const totalFirstWriter = runs.reduce((a, r) => a + r.first_writer_count, 0);
const totalReplayed = runs.reduce((a, r) => a + r.replayed_count, 0);
const allHoldIds = [...new Set(runs.flatMap((r) => r.distinct_hold_ids))];

console.log(`\n${runs.length} independent runner(s) each fired attempts using the SAME idempotency key`);
console.log(`total attempts: ${totalAttempts}  |  ok: ${totalOk}  |  rejected: ${totalAttempts - totalOk}`);
console.log(`of the ok responses: ${totalFirstWriter} did the actual write, ${totalReplayed} were replays`);
console.log(`distinct hold_id(s) returned across EVERY attempt, from EVERY machine: ${allHoldIds.length} -> [${allHoldIds.join(', ')}]`);

const problems = [];
if (allHoldIds.length !== 1) problems.push(`expected exactly 1 distinct hold_id across all runners; got ${allHoldIds.length}`);
if (totalFirstWriter !== 1) problems.push(`expected exactly 1 request to be the original write across all runners; got ${totalFirstWriter}`);

const after = await fetch(`${baseUrl}/api/inventory/${inventoryId}`).then((r) => r.json());
const consumed = after.total_units - after.booked_units - after.held_units;
const actuallyConsumed = initialFree - consumed;
console.log(`\ntarget row: total=${after.total_units} booked=${after.booked_units} held=${after.held_units}`);
console.log(`units consumed by this test: ${actuallyConsumed} (expected exactly ${units}, regardless of ${totalAttempts} attempts)`);
if (actuallyConsumed !== units) problems.push(`expected exactly ${units} unit(s) consumed (one hold's worth); got ${actuallyConsumed}`);

const inv = await fetch(`${baseUrl}/api/invariants`).then((r) => r.json());
console.log(`GET /api/invariants ->`, inv.counts);
if (!inv.ok) problems.push(`database invariants failed: ${JSON.stringify(inv.counts)}`);

if (doRelease && allHoldIds[0]) {
  const res = await fetch(`${baseUrl}/api/holds/${allHoldIds[0]}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  console.log(`\nreleased ${allHoldIds[0]}: ${res.ok ? 'ok' : 'failed'}`);
}

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(
  `\nIDEMPOTENT ACROSS ${runs.length} INDEPENDENT MACHINES: ${totalAttempts} attempts using the same key, exactly 1 hold ever created.`,
);
