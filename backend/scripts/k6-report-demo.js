// A traditional ramping load test, purely to get a graph/report out of k6 — complementary to
// k6-loadtest.js, not a replacement. k6-loadtest.js proves zero oversell with a single
// instantaneous burst (which finishes in well under a second, too fast for k6's own dashboard/
// HTML export to have "enough data" — verified: it logs exactly that and skips the report). This
// script instead ramps VUs up over real wall-clock time against a safe, repeatable, read-only
// endpoint (search), so there's a genuine curve to render. It says nothing about the oversell
// guarantee — that proof lives in k6-loadtest.js, gh-fire.mjs/gh-verify.mjs, and the dashboard.
//
// Run:  k6 run --out 'web-dashboard=export=k6-report.html' scripts/k6-report-demo.js
//       (or set K6_WEB_DASHBOARD=true and watch it live at http://127.0.0.1:5665 while it runs)
//       k6 run -e BASE_URL=https://your-tunnel-or-deploy scripts/k6-report-demo.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PEAK_VUS = Number(__ENV.PEAK_VUS || 50);

// A handful of real, bookable cities (see backend/README.md "Data notes" — only some cities have
// inventory), so results are non-empty and every request does genuine work: city/date filtering,
// joins across hotels/room_types/rate_plans, FX conversion.
const CITIES = ['Jaipur', 'Agra', 'Udaipur', 'Varanasi', 'Jaisalmer', 'Kolkata', 'New Delhi'];
const randomCity = () => CITIES[Math.floor(Math.random() * CITIES.length)];
const randomDate = () => {
  const d = new Date(Date.UTC(2026, 8, 22) + Math.floor(Math.random() * 60) * 86_400_000); // within the seeded window
  return d.toISOString().slice(0, 10);
};

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: PEAK_VUS }, // ramp up
        { duration: '20s', target: PEAK_VUS }, // hold
        { duration: '10s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // real failures, not "no hotels for this city/date" — see checks below
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const city = randomCity();
  const check_in = randomDate();
  const res = http.get(
    `${BASE_URL}/api/search/hotels?city=${encodeURIComponent(city)}&check_in=${check_in}&nights=2&adults=2&currency=INR`,
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response is valid JSON': (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });
  sleep(Math.random() * 0.5); // a little think-time so VUs don't all fire in perfect lockstep
}
