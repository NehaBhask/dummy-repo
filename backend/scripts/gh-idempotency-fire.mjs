#!/usr/bin/env node
// Fires K concurrent requests using the SAME idempotency key (passed in, shared across every
// runner in the workflow) — the "many independent retries of the identical action, from real
// separate machines" test. Complements gh-fire.mjs (unique keys, proves serialization under
// contention); this proves the different guarantee: retries never double-book, even when the
// retries genuinely originate from different machines at the same instant, not just one script
// calling twice in a row.
//
// Usage: node gh-idempotency-fire.mjs --base-url <url> --inventory <id> --key <shared-key>
//                                      [--attempts 20] [--tag r0] [--out result.json]
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

const baseUrl = arg('base-url');
const inventoryId = arg('inventory');
const key = arg('key');
const attempts = Number(arg('attempts', 20));
const units = Number(arg('units', 1));
const tag = arg('tag', 'runner');
const out = arg('out', 'result.json');

if (!baseUrl || !inventoryId || !key) {
  console.error('usage: gh-idempotency-fire.mjs --base-url <url> --inventory <id> --key <shared-key> [--attempts 20]');
  process.exit(2);
}

async function attempt() {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ items: [{ inventory_id: inventoryId, units }], ttl_seconds: 120 }),
    });
    const body = await res.json().catch(() => null);
    const latency = performance.now() - start;
    if (res.ok) return { ok: true, http: res.status, hold_id: body?.holds?.[0]?.hold_id ?? null, replayed: body?.replayed ?? null, latency };
    return { ok: false, http: res.status, code: body?.error?.code, latency };
  } catch (err) {
    return { ok: false, http: null, code: err.cause?.code ?? err.message, latency: performance.now() - start };
  }
}

// Every attempt queued first, released together — this runner's own K attempts genuinely race
// each other, on top of racing every other runner's attempts using the identical key.
let open;
const gate = new Promise((r) => (open = r));
const pending = Array.from({ length: attempts }, () => gate.then(attempt));
await new Promise((r) => setTimeout(r, 25));
open();
const results = await Promise.all(pending);

const holdIds = [...new Set(results.filter((r) => r.hold_id).map((r) => r.hold_id))];
const summary = {
  tag,
  key,
  attempts,
  ok: results.filter((r) => r.ok).length,
  rejected: results.filter((r) => !r.ok).length,
  distinct_hold_ids: holdIds, // must be a single value across THIS runner, and across all runners combined
  replayed_count: results.filter((r) => r.replayed === true).length,
  first_writer_count: results.filter((r) => r.replayed === false).length,
  rejected_codes: [...new Set(results.filter((r) => !r.ok).map((r) => r.code))],
};
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  `[${tag}] ${summary.ok}/${attempts} ok, ${summary.first_writer_count} were the original write, ` +
    `${summary.replayed_count} were replays, ${holdIds.length} distinct hold_id(s): ${holdIds.join(',') || 'none'}`,
);
if (summary.rejected_codes.length) console.log(`  rejected codes: ${summary.rejected_codes.join(', ')}`);
