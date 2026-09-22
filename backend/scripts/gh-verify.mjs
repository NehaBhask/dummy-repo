#!/usr/bin/env node
// Combines every runner's result.json, checks the DATABASE's own invariants (not just our own
// request counts — those could be wrong if a response was lost), confirms total granted never
// exceeded the units that were actually free, and restocks the room by releasing every hold this
// workflow created, so it's ready to race again next time.
//
// Exits non-zero (fails the GitHub Actions job, shown as a red X) if anything looks wrong.
//
// Usage:
//   node gh-verify.mjs --base-url <url> --inventory <id> --initial-free 3 --results-dir results [--release]

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
const initialFree = Number(arg('initial-free'));
const resultsDir = arg('results-dir');
const doRelease = flag('release');

if (!baseUrl || !inventoryId || !resultsDir || !Number.isFinite(initialFree)) {
  console.error('usage: gh-verify.mjs --base-url <url> --inventory <id> --initial-free <n> --results-dir <dir> [--release]');
  process.exit(2);
}

function findResultFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out = out.concat(findResultFiles(p));
    else if (entry === 'result.json') out.push(p);
  }
  return out;
}

const files = findResultFiles(resultsDir);
if (!files.length) {
  console.error(`no result.json files found under ${resultsDir}`);
  process.exit(2);
}
const runs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));

const totals = runs.reduce(
  (a, r) => ({
    requests: a.requests + r.requests,
    success: a.success + r.success,
    sold_out: a.sold_out + r.sold_out,
    error: a.error + r.error,
    hold_ids: a.hold_ids.concat(r.granted_hold_ids),
  }),
  { requests: 0, success: 0, sold_out: 0, error: 0, hold_ids: [] },
);

console.log(`\n${runs.length} independent runner(s) (separate GitHub-hosted machines) fired ${totals.requests} requests total`);
console.log(`granted: ${totals.success}   sold_out: ${totals.sold_out}   errors: ${totals.error}`);
console.log(`free units on the target row before the storm: ${initialFree}`);

const problems = [];
if (totals.success > initialFree) problems.push(`granted (${totals.success}) exceeds the initial free units (${initialFree}) — OVERSELL`);
if (new Set(totals.hold_ids).size !== totals.hold_ids.length) problems.push('the same hold_id was reported as granted more than once — duplicate grant');
if (totals.error > 0) console.log(`note: ${totals.error} request(s) errored (not sold_out) — see each runner's errors_sample`);

const inv = await fetch(`${baseUrl}/api/invariants`).then((r) => r.json());
console.log(`\nGET /api/invariants ->`, inv.counts);
if (!inv.ok) problems.push(`database invariants failed: ${JSON.stringify(inv.counts)}`);

const before = await fetch(`${baseUrl}/api/inventory/${inventoryId}`).then((r) => r.json());
console.log(`target row: total=${before.total_units} booked=${before.booked_units} held=${before.held_units}`);

if (doRelease && totals.hold_ids.length) {
  console.log(`\nreleasing ${totals.hold_ids.length} hold(s) created by this workflow...`);
  const results = await Promise.allSettled(
    totals.hold_ids.map((id) =>
      fetch(`${baseUrl}/api/holds/${id}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ),
  );
  const failed = results.filter((r) => r.status === 'rejected' || !r.value.ok).length;
  if (failed) problems.push(`${failed} hold(s) failed to release`);

  const after = await fetch(`${baseUrl}/api/inventory/${inventoryId}`).then((r) => r.json());
  const restoredFree = after.total_units - after.booked_units - after.held_units;
  console.log(`target row after cleanup: total=${after.total_units} booked=${after.booked_units} held=${after.held_units}  (free: ${restoredFree}, was ${initialFree})`);
}

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`\nZERO OVERSELL across ${runs.length} independent runners on separate machines.`);
