// Fails if any translation key used in src/ is missing from a locale, if the two locales differ,
// or if a placeholder like {n} exists in one language but not the other.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'));
const hi = JSON.parse(readFileSync('src/locales/hi.json', 'utf8'));
const files = [];
(function walk(d) {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    f.isDirectory() ? walk(p) : /\.jsx?$/.test(f.name) && files.push(p);
  }
})('src');

// keys reached through expressions the regex below cannot see (t(cond ? 'a' : 'b'), t(LABEL[x]))
const used = new Set(['nav.explore', 'nav.trip', 'nav.bookings', 'nav.visualizer', 'nav.loadtest', 'viz.race', 'viz.saga', 'viz.retry', 'bookings.emptyUpcoming', 'bookings.emptyPast', 'search.count1', 'search.flightCount1']);
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
  for (const m of s.matchAll(/EXAMPLES = \[([^\]]+)\]/g)) for (const k of m[1].matchAll(/'([^']+)'/g)) used.add(k[1]);
}
const problems = [];
for (const k of used) for (const [name, d] of [['en', en], ['hi', hi]]) if (!(k in d)) problems.push(`missing in ${name}: ${k}`);
for (const k of Object.keys(en)) if (!(k in hi)) problems.push(`missing in hi: ${k}`);
for (const k of Object.keys(hi)) if (!(k in en)) problems.push(`missing in en: ${k}`);
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of Object.keys(en)) if (k in hi && ph(en[k]) !== ph(hi[k])) problems.push(`placeholder mismatch: ${k}  en{${ph(en[k])}} hi{${ph(hi[k])}}`);
// dynamic keys: every enum value the UI can pass in
const dynamic = {
  status: ['confirmed','captured','active','completed','success','pending','initiated','authorised','partially_confirmed','running','cancelled','refunded','voided','released','expired','failed','compensated','sold_out'],
  failure: ['hold_expired','sold_out','over_budget','invalid_id','currency_mismatch','idempotency_conflict','constraint_infeasible','low_confidence'],
  ptype: ['hotel','resort','homestay','hostel','apartment','boutique','heritage','guesthouse'],
  bed: ['single','twin','double','queen','king','bunk','twin_double'],
  method: ['mock','card','upi','netbanking','wallet'],
  cabin: ['economy','premium_economy','business','first'],
  pref: ['breakfast','refundable'],
  'lt.inv': ['oversold','negative','held_drift','booked_drift'],
  'pay.err': ['number','name','expiry','cvv','upi'],
  'ops.kind': ['hold','booking','rejected'],
  'chat.page': ['explore','hotel_search','flight_search','hotel','trip','bookings','confirmation','visualizer','loadtest'],
};
for (const [p, vals] of Object.entries(dynamic)) for (const v of vals) for (const [n, d] of [['en', en], ['hi', hi]]) if (!(`${p}.${v}` in d)) problems.push(`missing in ${n}: ${p}.${v}`);
console.log(`${used.size} static keys used, ${Object.keys(en).length} en / ${Object.keys(hi).length} hi entries`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('i18n OK');
