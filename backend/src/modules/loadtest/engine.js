import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { pool, withTx, lockInventory } from '../../db.js';
import { config } from '../../config.js';
import { AppError, fromPgError, metrics } from '../../errors.js';
import { newId } from '../../ids.js';
import { createHold } from '../booking/holds.js';
import { checkInvariants } from '../invariants.js';
import { describeInventory, inventoryTitle } from '../inventory/availability.js';
import { findContendedInventory } from '../inventory/search.js';
import { clearSoldOut } from '../inventory/soldout.js';

/*
 * Load-test engine — the standout deliverable. It races N travellers at ONE scarce inventory row
 * and then checks the database, not the responses, to prove the invariant held.
 *
 *  - every request is a real POST /api/holds (mode "api"), or a direct call into the service
 *    (mode "direct") to take HTTP out of the picture
 *  - duplicate_factor > 1 sends each logical request several times with the SAME idempotency key,
 *    simultaneously: the "retries never double-book" proof
 *  - the verdict reads inventory_calendar and holds afterwards: no oversell, exactly the free
 *    units granted, no request granted twice, counters reconcile with the holds table, and the
 *    database CHECK constraint never had to fire
 *  - test holds are released afterwards (status 'released', never deleted — R8)
 */

// A real client fleet sits behind connection pools, so the generator reuses a bounded set of
// keep-alive sockets rather than opening one per request. All N requests are still released at
// the same instant; the ones beyond the socket cap wait client-side and that wait shows in latency.
const maxSockets = Number(process.env.LOADTEST_MAX_SOCKETS) || 100;
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets }),
  'https:': new https.Agent({ keepAlive: true, maxSockets }),
};

function postJson(baseUrl, path, headers, payload) {
  const u = new URL(path, baseUrl);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        agent: agents[u.protocol], hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON error page */ }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// Connection-level failures mean the request never reached the application, so replaying it is
// safe (and every request carries an idempotency key anyway). Retries are counted and reported.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
async function postWithRetry(run, ...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJson(...args);
    } catch (err) {
      if (!TRANSIENT.has(err?.code) || attempt >= 3) throw err;
      run.transport_retries++;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
    }
  }
}

const runs = new Map();
const KEEP = 25;
const MAX_REQUESTS = 1000;

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0);
const round2 = (n) => Math.round(n * 100) / 100;

function latencyStats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { p50_ms: round2(pct(s, 0.5)), p95_ms: round2(pct(s, 0.95)), p99_ms: round2(pct(s, 0.99)), max_ms: round2(s.at(-1) ?? 0) };
}

async function readRow(id) {
  const { rows } = await pool.query(
    `SELECT inventory_id, total_units, booked_units, held_units,
            (total_units - booked_units - held_units)::int AS free_units
       FROM inventory_calendar WHERE inventory_id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function remoteSafetyNet(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/metrics`);
    return (await res.json()).safety_net_hits;
  } catch {
    return null;
  }
}

/** Validate options and create the run; returns immediately with `run.done` resolving at the end. */
export async function startLoadTest(opts = {}, { baseUrl } = {}) {
  const requests = Math.trunc(opts.concurrent_requests ?? 200);
  const units = Math.trunc(opts.units_per_request ?? 1);
  const dup = Math.trunc(opts.duplicate_factor ?? 1);
  const mode = opts.mode ?? 'api';
  const bypass = opts.bypass_shield !== false; // default: attack the database, not the in-process queue
  if (!(requests >= 1 && requests <= MAX_REQUESTS)) {
    throw new AppError('validation_error', { details: { concurrent_requests: `1..${MAX_REQUESTS}` } });
  }
  if (!(units >= 1 && units <= 5)) throw new AppError('validation_error', { details: { units_per_request: '1..5' } });
  if (!(dup >= 1 && dup <= 5)) throw new AppError('validation_error', { details: { duplicate_factor: '1..5' } });
  if (mode !== 'api' && mode !== 'direct') throw new AppError('validation_error', { details: { mode: 'api|direct' } });

  let inventoryId = opts.inventory_id;
  if (!inventoryId) {
    inventoryId = (await findContendedInventory(1))[0]?.inventory_id;
    if (!inventoryId) throw new AppError('invalid_id', { details: { reason: 'no contended inventory found' } });
  }
  const before = await readRow(inventoryId);
  if (!before) throw new AppError('invalid_id', { details: { inventory_id: inventoryId } });

  const userId =
    opts.user_id ?? (await pool.query(`SELECT user_id FROM users WHERE status = 'active' ORDER BY user_id LIMIT 1`)).rows[0].user_id;
  const desc = (await describeInventory([inventoryId])).get(inventoryId);
  const runId = newId('ltr');
  const expected = Math.min(requests, Math.floor(before.free_units / units));

  await pool.query(
    `INSERT INTO load_test_runs (run_id, target_inventory_id, mode, status, concurrent_requests, duplicate_factor,
                                 units_per_request, initial_free, expected_successes, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, now(), now())`,
    [runId, inventoryId, mode, requests, dup, units, before.free_units, expected],
  );

  const run = {
    run_id: runId,
    status: 'running',
    mode,
    target: { ...before, title: desc ? inventoryTitle(desc) : inventoryId, for_date: desc?.for_date },
    config: { concurrent_requests: requests, duplicate_factor: dup, units_per_request: units, cleanup: opts.cleanup !== false, bypass_shield: bypass },
    expected_successes: expected,
    total_attempts: requests * dup,
    progress: { completed: 0, success: 0, sold_out: 0, error: 0, in_flight: 0 },
    timeline: [],
    transport_retries: 0,
    started_at: new Date().toISOString(),
    latencies: [],
  };
  runs.set(runId, run);
  if (runs.size > KEEP) runs.delete(runs.keys().next().value);

  run.done = execute(run, { requests, units, dup, mode, bypass, userId, inventoryId, before, baseUrl: config.loadTestBaseUrl || baseUrl })
    .catch(async (err) => {
      console.error('[loadtest] run failed:', err);
      run.status = 'failed';
      run.error = err.message;
      await pool
        .query(`UPDATE load_test_runs SET status = 'failed', finished_at = now(), updated_at = now() WHERE run_id = $1`, [runId])
        .catch(() => {});
    });
  return run;
}

export async function runLoadTest(opts, ctx) {
  const run = await startLoadTest(opts, ctx);
  await run.done;
  return publicRun(run);
}

async function execute(run, o) {
  const t0 = performance.now();
  const attempts = [];
  for (let i = 0; i < o.requests; i++) {
    for (let d = 0; d < o.dup; d++) attempts.push({ logical: i, dup: d, key: `loadtest_${run.run_id}_${i}` });
  }

  const netBefore = o.mode === 'api' ? await remoteSafetyNet(o.baseUrl) : metrics.safetyNetHits;

  const oneRequest = async (a) => {
    const start = performance.now();
    let status = 'error';
    let holdId = null;
    let httpStatus = null;
    let code = null;
    run.progress.in_flight++;
    try {
      if (o.mode === 'api') {
        const res = await postWithRetry(
          run,
          o.baseUrl,
          '/api/holds',
          { 'content-type': 'application/json', 'idempotency-key': a.key, ...(o.bypass ? { 'x-bypass-shield': '1' } : {}) },
          JSON.stringify({ user_id: o.userId, items: [{ inventory_id: o.inventoryId, units: o.units }], ttl_seconds: 300 }),
        );
        httpStatus = res.status;
        const body = res.body;
        if (res.status >= 200 && res.status < 300) {
          status = 'success';
          holdId = body?.holds?.[0]?.hold_id ?? null;
        } else {
          code = body?.error?.code ?? `http_${res.status}`;
          status = code === 'sold_out' ? 'sold_out' : 'error';
        }
      } else {
        try {
          const r = await createHold({
            userId: o.userId,
            items: [{ inventory_id: o.inventoryId, units: o.units }],
            idempotencyKey: a.key,
            ttlSeconds: 300,
            bypassShield: o.bypass,
          });
          status = 'success';
          holdId = r.holds[0].hold_id;
        } catch (err) {
          const e = fromPgError(err);
          code = e.code ?? e.name;
          status = code === 'sold_out' ? 'sold_out' : 'error';
        }
      }
    } catch (err) {
      code = err?.code ?? err?.cause?.code ?? err?.message ?? err?.name ?? 'network_error';
    }
    const latency = performance.now() - start;
    run.progress.in_flight--;
    run.progress.completed++;
    run.progress[status]++;
    run.latencies.push(latency);
    return { ...a, status, latency_ms: latency, hold_id: holdId, http_status: httpStatus, error_code: code };
  };

  // Release every request at the same instant so they genuinely contend.
  let open;
  const gate = new Promise((r) => (open = r));
  const pending = attempts.map((a) => gate.then(() => oneRequest(a)));

  // Evidence that contention really reached Postgres: sessions blocked on a lock, sampled during the race.
  let peakLockWaiters = 0;
  let peakActive = 0;
  let sampling = true;
  const lockSampler = (async () => {
    while (sampling) {
      try {
        const { rows } = await pool.query(
          `SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting,
                  count(*) FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::int AS active
             FROM pg_stat_activity WHERE datname = current_database()`,
        );
        peakLockWaiters = Math.max(peakLockWaiters, rows[0].waiting);
        peakActive = Math.max(peakActive, rows[0].active);
      } catch { /* sampling is best-effort */ }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  let ticks = 0;
  const sampler = setInterval(() => {
    if (run.timeline.length < 1200) run.timeline.push({ t_ms: Math.round(performance.now() - t0), ...run.progress });
    if (++ticks % 3 === 0) saveSnapshot(run); // ~every 300 ms, so any worker process can serve the poll
  }, 100);
  await new Promise((r) => setTimeout(r, 25)); // let every promise register before the gate opens
  const raceStart = performance.now();
  open();
  const results = await Promise.all(pending);
  const raceMs = performance.now() - raceStart;
  clearInterval(sampler);
  sampling = false;
  await lockSampler;
  run.timeline.push({ t_ms: Math.round(performance.now() - t0), ...run.progress });

  // ---- verify against the database, not against the responses --------------------------------
  const after = await readRow(o.inventoryId);
  const netAfter = o.mode === 'api' ? await remoteSafetyNet(o.baseUrl) : metrics.safetyNetHits;

  const byLogical = new Map();
  for (const r of results) {
    const g = byLogical.get(r.logical) ?? { holds: new Set(), statuses: new Set() };
    g.statuses.add(r.status);
    if (r.hold_id) g.holds.add(r.hold_id);
    byLogical.set(r.logical, g);
  }
  let successes = 0, soldOut = 0, errors = 0, doubleGranted = 0;
  const distinctHolds = new Set();
  for (const g of byLogical.values()) {
    if (g.holds.size > 1) doubleGranted++;
    for (const h of g.holds) distinctHolds.add(h);
    if (g.statuses.has('success')) successes++;
    else if (g.statuses.has('sold_out')) soldOut++;
    else errors++;
  }
  const grantedUnits = distinctHolds.size * o.units;
  const activeHolds = (
    await pool.query(
      `SELECT count(*)::int n, COALESCE(sum(units), 0)::int units FROM holds
        WHERE inventory_id = $1 AND status = 'active' AND starts_with(idempotency_key, $2)`,
      [o.inventoryId, `loadtest_${run.run_id}_`],
    )
  ).rows[0];
  const global = await checkInvariants();
  const scoped = await checkInvariants(pool, { inventoryIds: [o.inventoryId] });
  const oversold = after.booked_units + after.held_units > after.total_units;
  const netHits = netBefore == null || netAfter == null ? null : netAfter - netBefore;

  const checks = {
    no_oversell: !oversold && global.counts.oversold === 0,
    exactly_free_units_granted: successes === run.expected_successes,
    no_request_granted_twice: doubleGranted === 0 && distinctHolds.size === successes,
    counters_reconcile:
      after.held_units - o.before.held_units === grantedUnits && activeHolds.units === grantedUnits && scoped.ok,
    db_check_never_fired: netHits === null ? null : netHits === 0,
    no_transport_or_server_errors: errors === 0,
  };
  const passed = Object.values(checks).every((v) => v !== false);
  const stats = latencyStats(run.latencies);

  const verdict = {
    passed,
    checks,
    detail: {
      initial_free: o.before.free_units,
      expected_successes: run.expected_successes,
      successes,
      sold_out: soldOut,
      errors,
      duplicate_attempts_sent: o.requests * (o.dup - 1),
      transport_retries: run.transport_retries,
      shield_bypassed: o.bypass,
      peak_db_sessions_blocked_on_row_lock: peakLockWaiters,
      peak_db_active_sessions: peakActive,
      granted_units: grantedUnits,
      after_race: after,
      db_check_hits: netHits,
      invariants: { global: global.counts, target: scoped.counts },
    },
  };

  // ---- clean up the test holds so shared data is left as we found it --------------------------
  let cleanup = null;
  if (run.config.cleanup) {
    const released = await releaseRunHolds(run.run_id, o.inventoryId);
    const restored = await readRow(o.inventoryId);
    cleanup = { released_holds: released, restored_to_initial: restored.held_units === o.before.held_units && restored.booked_units === o.before.booked_units };
  }

  Object.assign(run, {
    status: 'completed',
    finished_at: new Date().toISOString(),
    duration_ms: Math.round(raceMs),
    throughput_rps: round2(results.length / (raceMs / 1000)),
    summary: { successes, sold_out: soldOut, errors, failures: soldOut + errors, ...stats },
    verdict,
    cleanup,
    histogram: histogram(run.latencies),
  });

  await persist(run, results);
  await saveSnapshot(run, true);
}

async function releaseRunHolds(runId, inventoryId) {
  return withTx(async (c) => {
    // hold rows first, then the inventory row — the same order as every other path
    const { rows } = await c.query(
      `SELECT hold_id, units FROM holds WHERE status = 'active' AND starts_with(idempotency_key, $1) ORDER BY hold_id FOR UPDATE`,
      [`loadtest_${runId}_`],
    );
    if (!rows.length) return 0;
    await lockInventory(c, [inventoryId]);
    clearSoldOut([inventoryId]);
    await c.query(
      `UPDATE holds SET status = 'released', released_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE hold_id = ANY($1::text[])`,
      [rows.map((r) => r.hold_id)],
    );
    await c.query(
      `UPDATE inventory_calendar SET held_units = held_units - $2, updated_at = statement_timestamp() WHERE inventory_id = $1`,
      [inventoryId, rows.reduce((a, r) => a + r.units, 0)],
    );
    return rows.length;
  });
}

async function persist(run, results) {
  const s = run.summary;
  await pool.query(
    `UPDATE load_test_runs
        SET status = 'completed', successes = $2, sold_out = $3, errors = $4, failures = $5,
            invariant_violations = $6, oversold = $7, p50_ms = $8, p95_ms = $9, p99_ms = $10, max_ms = $11,
            duration_ms = $12, throughput_rps = $13, verdict = $14, finished_at = now(), updated_at = now()
      WHERE run_id = $1`,
    [
      run.run_id, s.successes, s.sold_out, s.errors, s.failures,
      run.verdict.detail.invariants.global.oversold + run.verdict.detail.invariants.global.negative,
      !run.verdict.checks.no_oversell,
      s.p50_ms, s.p95_ms, s.p99_ms, s.max_ms, run.duration_ms, run.throughput_rps, JSON.stringify(run.verdict),
    ],
  );
  for (let i = 0; i < results.length; i += 1000) {
    const chunk = results.slice(i, i + 1000);
    await pool.query(
      `INSERT INTO load_test_results (result_id, run_id, attempt_no, status, latency_ms, http_status, error_code, hold_id, created_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::int[], $7::text[], $8::text[], $9::timestamptz[])`,
      [
        chunk.map(() => newId('ltrs')),
        chunk.map(() => run.run_id),
        chunk.map((_, j) => i + j),
        chunk.map((r) => r.status),
        chunk.map((r) => round2(r.latency_ms)),
        chunk.map((r) => r.http_status),
        chunk.map((r) => r.error_code),
        chunk.map((r) => r.hold_id),
        chunk.map(() => new Date()),
      ],
    );
  }
}

function histogram(latencies, buckets = 20) {
  if (!latencies.length) return [];
  const max = Math.max(...latencies);
  const width = Math.max(max / buckets, 0.01);
  const out = Array.from({ length: buckets }, (_, i) => ({ from_ms: round2(i * width), to_ms: round2((i + 1) * width), count: 0 }));
  for (const l of latencies) out[Math.min(buckets - 1, Math.floor(l / width))].count++;
  return out;
}

export function publicRun(run) {
  const { latencies, done, ...rest } = run;
  return {
    ...rest,
    live: run.status === 'running' ? { ...latencyStats(latencies), elapsed_ms: Date.now() - Date.parse(run.started_at) } : undefined,
  };
}

// The process that owns a run keeps it in memory; it also mirrors it into load_test_runs.snapshot so
// that when the API runs as several worker processes, whichever one receives the poll can answer.
const saving = new Set();
async function saveSnapshot(run, force = false) {
  if (saving.has(run.run_id) && !force) return; // skip if the previous write is still in flight
  saving.add(run.run_id);
  try {
    await pool.query('UPDATE load_test_runs SET snapshot = $2, updated_at = now() WHERE run_id = $1', [
      run.run_id,
      JSON.stringify(publicRun(run)),
    ]);
  } catch (err) {
    console.error('[loadtest] snapshot write failed:', err.message);
  } finally {
    saving.delete(run.run_id);
  }
}

export async function getRun(runId) {
  const live = runs.get(runId);
  if (live) return publicRun(live);
  const { rows } = await pool.query('SELECT * FROM load_test_runs WHERE run_id = $1', [runId]);
  if (!rows[0]) throw new AppError('invalid_id', { details: { run_id: runId } });
  const { snapshot, ...row } = rows[0];
  return snapshot ? { ...snapshot, persisted: true } : { ...row, persisted: true };
}

export async function listRuns(limit = 20) {
  const { rows } = await pool.query(
    `SELECT run_id, target_inventory_id, mode, status, concurrent_requests, duplicate_factor, units_per_request,
            initial_free, expected_successes, successes, sold_out, errors, invariant_violations, oversold,
            p50_ms, p95_ms, p99_ms, max_ms, duration_ms, throughput_rps, (verdict->>'passed')::boolean AS passed,
            created_at, finished_at
       FROM load_test_runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
