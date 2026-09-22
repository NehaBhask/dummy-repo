#!/usr/bin/env node
// Fires N concurrent POST /api/holds at a running Kognivera backend and writes a JSON summary.
//
// Deliberately dependency-free (built-in fetch only): a GitHub Actions runner firing requests
// should spend its time firing requests, not running `npm install` first. One process = one
// independent "runner", meant to be launched from several GitHub-hosted VMs at once (see
// .github/workflows/distributed-load-test.yml) so the concurrency is real, not simulated.
//
// Usage:
//   node gh-fire.mjs --base-url https://your-app --inventory inv_xxx --requests 40 --tag r0 --out result.json

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const baseUrl = arg('base-url');
const inventoryId = arg('inventory');
const requests = Number(arg('requests', 40));
const tag = arg('tag', `anon-${Date.now()}`);
const units = Number(arg('units', 1));
const out = arg('out', 'result.json');
// Skips the server's in-memory sold-out shield so every request contends for Postgres' row lock
// directly (see backend/src/modules/inventory/soldout.js). Honoured only outside NODE_ENV=production.
const bypassShield = !flag('shield');

if (!baseUrl || !inventoryId) {
  console.error('usage: gh-fire.mjs --base-url <url> --inventory <id> [--requests 40] [--tag mytag] [--out result.json]');
  process.exit(2);
}

function percentile(vals, p) {
  const s = [...vals].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : null;
}

async function fireOne(i) {
  const key = `${tag}-${i}`;
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/holds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(bypassShield ? { 'x-bypass-shield': '1' } : {}),
      },
      body: JSON.stringify({ items: [{ inventory_id: inventoryId, units }], ttl_seconds: 300 }),
    });
    const body = await res.json().catch(() => null);
    const latency = performance.now() - start;
    if (res.ok) return { status: 'success', latency, hold_id: body?.holds?.[0]?.hold_id ?? null, http: res.status };
    return { status: body?.error?.code === 'sold_out' ? 'sold_out' : 'error', latency, http: res.status, code: body?.error?.code };
  } catch (err) {
    return { status: 'error', latency: performance.now() - start, code: err.message };
  }
}

// Queue every request first, then release them all at once, so THIS runner's own contribution
// to the race is genuinely concurrent (same gate pattern the dashboard's engine uses).
let open;
const gate = new Promise((r) => (open = r));
const pending = Array.from({ length: requests }, (_, i) => gate.then(() => fireOne(i)));
await new Promise((r) => setTimeout(r, 25)); // let every .then() register before releasing the gate
const raceStart = performance.now();
open();
const results = await Promise.all(pending);
const raceMs = performance.now() - raceStart;

const summary = {
  tag,
  base_url: baseUrl,
  inventory_id: inventoryId,
  requests,
  race_ms: Math.round(raceMs),
  success: results.filter((r) => r.status === 'success').length,
  sold_out: results.filter((r) => r.status === 'sold_out').length,
  error: results.filter((r) => r.status === 'error').length,
  granted_hold_ids: results.filter((r) => r.hold_id).map((r) => r.hold_id),
  latency_ms: { p50: percentile(results.map((r) => r.latency), 0.5), p99: percentile(results.map((r) => r.latency), 0.99) },
  errors_sample: results.filter((r) => r.status === 'error').slice(0, 5),
};

writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[${tag}] ${summary.success} granted, ${summary.sold_out} sold_out, ${summary.error} errors, ${summary.race_ms} ms`);
if (summary.errors_sample.length) console.log('sample errors:', JSON.stringify(summary.errors_sample));
