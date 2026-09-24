import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../backend/src/config.js';
import { pool, closePool } from '../backend/src/db.js';
import { parseHeuristic, aiSearch } from '../ai/search.js';

after(closePool);

const names = ['Jaipur', 'Panaji', 'Mumbai', 'New Delhi', 'Bengaluru', 'Agra', 'Goa Velha'];
const today = '2026-09-21';

test('heuristic parser: the design’s demo query', () => {
  const p = parseHeuristic('3-star hotel in Jaipur for 2 adults, Oct 10-12, under ₹5000/night, breakfast included', today, names);
  assert.equal(p.city, 'Jaipur');
  assert.equal(p.check_in_date, '2026-10-10');
  assert.equal(p.nights, 2);
  assert.equal(p.adults, 2);
  assert.equal(p.star_rating, 3);
  assert.equal(p.max_price_per_night, 5000);
  assert.equal(p.currency, 'INR');
  assert.deepEqual(p.preferences, ['breakfast']);
});

test('heuristic parser: aliases (Goa → Panaji), other currencies, past dates roll to next year', () => {
  assert.equal(parseHeuristic('family room in Goa, 3 nights, 2 rooms', today, names).city, 'Panaji');
  assert.equal(parseHeuristic('hotel in Bangalore', today, names).city, 'Bengaluru');
  assert.equal(parseHeuristic('hotel in Bangalore', today, ['Jaipur']).city, undefined, 'an alias only applies if its target city exists');
  const p = parseHeuristic('hotel in Mumbai from Jan 5 under $150', today, names);
  assert.equal(p.check_in_date, '2027-01-05', 'Jan 5 has passed in 2026, so the next occurrence is used');
  assert.equal(p.max_price_per_night, 150);
  assert.equal(p.currency, 'USD');
  assert.equal(parseHeuristic('Agra 2026-11-03 3 nights', today, names).check_in_date, '2026-11-03');
});

test('heuristic parser does not invent what was not said', () => {
  const p = parseHeuristic('hotel in Agra', today, names);
  assert.deepEqual(Object.keys(p).filter((k) => p[k] !== undefined), ['city']);
});

test('aiSearch: results are grounded (every room has the units it claims) and the query is logged', async (t) => {
  if (config.gemini.apiKey) return t.skip('a live Gemini key is configured; this test targets the offline path');
  const res = await aiSearch({ query: 'hotel in Jaipur Oct 10-12 for 2 adults under $200 in USD' });
  assert.equal(res.parser, 'heuristic');
  assert.ok(res.total > 0);
  for (const card of res.results) {
    for (const room of card.rooms) {
      const { rows } = await pool.query(
        'SELECT min(total_units - booked_units - held_units)::int AS f FROM inventory_calendar WHERE inventory_id = ANY($1)',
        [room.inventory.map((i) => i.inventory_id)],
      );
      assert.ok(rows[0].f >= 1 && rows[0].f === room.available_units);
    }
  }
  const log = await pool.query(`SELECT count(*)::int n FROM search_logs WHERE raw_query = $1`, ['hotel in Jaipur Oct 10-12 for 2 adults under $200 in USD']);
  assert.ok(log.rows[0].n >= 1);
  await pool.query(`DELETE FROM search_logs WHERE raw_query LIKE 'hotel in Jaipur Oct 10-12%'`);
});

test('aiSearch: Hindi without a Gemini key is a clear ai_unavailable, and an unknown city asks rather than guesses', async (t) => {
  if (config.gemini.apiKey) return t.skip('live key configured');
  await assert.rejects(aiSearch({ query: 'जयपुर में 2 रातों के लिए होटल, ₹5000 से कम' }), { code: 'ai_unavailable' });
  const r = await aiSearch({ query: 'a nice place somewhere' });
  assert.equal(r.needs_clarification, 'city');
});

test('aiSearch: a city with hotels but no inventory (Goa → Panaji) explains itself and suggests cities that do have rooms', async (t) => {
  if (config.gemini.apiKey) return t.skip('live key configured; this test targets the offline path');
  const r = await aiSearch({ query: 'family room in Goa, 3 nights, 2 rooms' });
  assert.equal(r.total, 0);
  assert.equal(r.no_results_reason, 'city_has_no_inventory');
  assert.ok(r.cities_with_inventory.includes('Jaipur'));
  await pool.query(`DELETE FROM search_logs WHERE raw_query = 'family room in Goa, 3 nights, 2 rooms'`);
});
