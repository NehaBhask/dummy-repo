// k6 load test: fires N virtual users at one scarce inventory row simultaneously, then verifies
// the actual guarantee against the database — not just its own request counts — via `teardown()`,
// so this is a self-contained proof (real oversell check), not just a request-firer next to the
// app's own dashboard/GitHub Actions proof. Complements those; doesn't replace the invariant logic
// they already have (k6 has no idea what "oversell" means for this schema on its own).
//
// Install:  winget install --id GrafanaLabs.k6 -e   (or see grafana.com/docs/k6/latest/set-up/install-k6/)
// Run:      k6 run scripts/k6-loadtest.js
//           k6 run -e BASE_URL=https://your-tunnel-or-deploy -e VUS=500 scripts/k6-loadtest.js
//           k6 run -e VUS=500 -e BYPASS_SHIELD=false scripts/k6-loadtest.js   (production path)
//           Graph of the race (live at http://127.0.0.1:5665 while running, plus an HTML file):
//             K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=race-report.html k6 run -e VUS=500 -e RAMP_SECONDS=10 scripts/k6-loadtest.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const INVENTORY_ID = __ENV.INVENTORY_ID || '';
const VUS = Number(__ENV.VUS || 200);
const BYPASS_SHIELD = (__ENV.BYPASS_SHIELD ?? 'true') !== 'false';
const TAG = `k6-${Date.now()}`;

const granted = new Counter('holds_granted');
const soldOut = new Counter('holds_sold_out');
const otherError = new Counter('holds_other_error');
const networkError = new Counter('holds_network_error'); // never reached the server (see default())
const holdLatency = new Trend('hold_latency_ms', true);

// RAMP_SECONDS=0 (default): all VUS fire in one instant (sharpest race, too short for a k6 graph).
// RAMP_SECONDS>0: the same VUS requests are spread evenly over that many seconds, so the k6 web
// dashboard / HTML report has enough data to plot, and the OS accept queue isn't hit by one burst.
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 0);

export const options = {
  scenarios: {
    race: RAMP_SECONDS > 0
      ? {
          executor: 'constant-arrival-rate',
          rate: VUS,
          timeUnit: `${RAMP_SECONDS}s`,
          duration: `${RAMP_SECONDS}s`,
          preAllocatedVUs: Math.min(VUS, 200),
          maxVUs: VUS,
        }
      : { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '60s' },
  },
  // Not a pass/fail gate on its own — the real one is the invariant check() in teardown().
  thresholds: { holds_other_error: ['count==0'] },
};

export function setup() {
  let inventoryId = INVENTORY_ID;
  if (!inventoryId) {
    const res = http.get(`${BASE_URL}/api/inventory/contended?limit=1`);
    inventoryId = res.json('inventory.0.inventory_id');
    if (!inventoryId) throw new Error('no contended inventory row found — is the backend seeded?');
  }
  const before = http.get(`${BASE_URL}/api/inventory/${inventoryId}`).json();
  const initialFree = before.total_units - before.booked_units - before.held_units;
  console.log(`\ntarget: ${inventoryId}  (${before.total_units} total, ${initialFree} free right now)`);
  console.log(`racing ${VUS} virtual users, mode: ${BYPASS_SHIELD ? 'shield bypassed (raw row lock)' : 'shield enabled (production path)'}\n`);
  return { inventoryId, initialFree, beforeHeld: before.held_units, beforeBooked: before.booked_units };
}

export default function (data) {
  // 8-char idempotency-key floor (backend/src/validation.js) — pad regardless of __VU width.
  // A VU can run several iterations in ramp mode, so the key needs __ITER too or retries would collide.
  const key = `${TAG}-${String(__VU).padStart(5, '0')}-${String(__ITER).padStart(4, '0')}`;
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
  if (BYPASS_SHIELD) headers['X-Bypass-Shield'] = '1';

  const res = http.post(
    `${BASE_URL}/api/holds`,
    JSON.stringify({ items: [{ inventory_id: data.inventoryId, units: 1 }], ttl_seconds: 60 }),
    { headers },
  );
  holdLatency.add(res.timings.duration);

  if (res.status === 201 || res.status === 200) {
    granted.add(1);
    check(res, { 'hold granted': (r) => JSON.parse(r.body).holds?.[0]?.hold_id != null });
  } else if (res.status === 0 || res.body == null) {
    // Never reached the server at all (connection refused/reset/timeout) — res.body is null here,
    // so res.json() would throw. This is a transport failure, not an application response; tag it
    // distinctly rather than let an uncaught exception spam the console for every occurrence.
    networkError.add(1);
  } else {
    const code = res.json('error.code');
    if (code === 'sold_out') soldOut.add(1);
    else {
      otherError.add(1);
      console.error(`unexpected response VU=${__VU} status=${res.status} code=${code}`);
    }
  }
}

export function teardown(data) {
  const inv = http.get(`${BASE_URL}/api/invariants`).json();
  const after = http.get(`${BASE_URL}/api/inventory/${data.inventoryId}`).json();
  // Units this specific run added to the row, isolated from whatever was already booked/held
  // before it started (so a shared/reused row doesn't skew the count).
  const newlyConsumed = after.held_units - data.beforeHeld + (after.booked_units - data.beforeBooked);

  console.log(`\ntarget row after the race: total=${after.total_units} booked=${after.booked_units} held=${after.held_units}`);
  console.log(`this run consumed ${newlyConsumed} unit(s) of the ${data.initialFree} that were free before it started`);
  console.log(`(granted holds use a 60s TTL and self-expire; no manual cleanup needed)`);

  // The actual proof: read the database itself, not this script's own request counts.
  check(inv, {
    'no oversold rows (booked+held > total) anywhere in the database': (d) => d.counts.oversold === 0,
    'no negative counters': (d) => d.counts.negative === 0,
    'held_units matches the sum of active holds': (d) => d.counts.held_drift === 0,
    'booked_units matches the sum of confirmed items': (d) => d.counts.booked_drift === 0,
  });
  check(null, {
    'this run never consumed more than the units that were actually free': () => newlyConsumed <= data.initialFree,
  });
}
