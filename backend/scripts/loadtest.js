import { closePool } from '../src/db.js';
import { runLoadTest } from '../src/modules/loadtest/engine.js';
import { config } from '../src/config.js';

// Usage: node scripts/loadtest.js [--requests 500] [--inventory inv_…] [--units 1] [--dup 1]
//                                 [--base-url http://localhost:3000] [--direct] [--keep]
// Run it from a different process than the server so the load generator doesn't share the
// server's event loop. Exits non-zero if any correctness check fails.
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const baseUrl = arg('base-url', `http://127.0.0.1:${config.port}`);
const opts = {
  inventory_id: arg('inventory'),
  concurrent_requests: Number(arg('requests', 200)),
  units_per_request: Number(arg('units', 1)),
  duplicate_factor: Number(arg('dup', 1)),
  mode: flag('direct') ? 'direct' : 'api',
  cleanup: !flag('keep'),
  bypass_shield: !flag('shield'), // --shield keeps the in-process sold-out shield on (production behaviour)
};

try {
  const run = await runLoadTest(opts, { baseUrl });
  const { target, verdict: v, summary: s } = run;
  const yn = (x) => (x === null ? 'n/a ' : x ? 'PASS' : 'FAIL');

  console.log(`\nLoad test ${run.run_id}  [${run.mode}${run.mode === 'api' ? ` → ${baseUrl}` : ''}]`);
  console.log(`target   ${target.inventory_id}  ${target.title}  ${target.for_date}`);
  console.log(`before   total=${target.total_units} booked=${target.booked_units} held=${target.held_units}  →  free=${target.free_units}`);
  console.log(
    `race     ${run.config.concurrent_requests} concurrent requests × ${run.config.duplicate_factor} ` +
      `(same idempotency key) × ${run.config.units_per_request} unit(s), ${run.duration_ms} ms, ${run.throughput_rps} req/s`,
  );
  console.log(`database contention: peak ${v.detail.peak_db_sessions_blocked_on_row_lock} session(s) blocked on the row lock at once (${v.detail.peak_db_active_sessions} active)` +
    (v.detail.shield_bypassed ? '' : '   [in-process sold-out shield was ON: it queues requests before the database]'));
  console.log(`result   ${s.successes} granted · ${s.sold_out} sold_out · ${s.errors} errors    (expected ${run.expected_successes} granted)`);
  console.log(`latency  p50 ${s.p50_ms} ms · p95 ${s.p95_ms} ms · p99 ${s.p99_ms} ms · max ${s.max_ms} ms`);
  const after = v.detail.after_race;
  console.log(`after    total=${after.total_units} booked=${after.booked_units} held=${after.held_units}  free=${after.free_units}`);
  console.log('\nchecks');
  for (const [name, ok] of Object.entries(v.checks)) console.log(`  ${yn(ok)}  ${name}`);
  console.log(`\ninvariants (whole DB)  oversold=${v.detail.invariants.global.oversold} negative=${v.detail.invariants.global.negative}` +
    ` held_drift=${v.detail.invariants.global.held_drift} booked_drift=${v.detail.invariants.global.booked_drift}`);
  if (run.cleanup) console.log(`cleanup  released ${run.cleanup.released_holds} test hold(s); row restored: ${run.cleanup.restored_to_initial}`);
  console.log(`\n${v.passed ? 'ZERO OVERSELL — all checks passed' : 'FAILED'}`);
  process.exitCode = v.passed ? 0 : 1;
} finally {
  await closePool();
}
