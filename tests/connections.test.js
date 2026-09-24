import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../backend/src/db.js';
import { startServer } from '../backend/src/server.js';
import { readInventory, testUsers, uniq, cleanupTestData, finish } from './helpers.js';

/*
 * One-stop flights: two legs where the second leaves the airport the first landed at, 60-360 minutes later.
 * Fixtures are real flight / fare / inventory rows dated 2031+ (removed by cleanupTestData), so nothing in the
 * provided seed is touched and the searches below see only these flights.
 */

let srv;
let airline;
let ap; // iata -> airport_id
let baseDay; // a free 2031+ date this file owns
before(async () => {
  await cleanupTestData();
  srv = await startServer({ port: 0, worker: false });
  airline = (await pool.query('SELECT airline_id FROM airlines ORDER BY airline_id LIMIT 1')).rows[0].airline_id;
  ap = Object.fromEntries((await pool.query(`SELECT iata, airport_id FROM airports WHERE iata IN ('BEN','NEW','NEZ','JAI')`)).rows.map((r) => [r.iata, r.airport_id]));
  baseDay = new Date(Date.UTC(2031, 0, 1) + (1 + Math.floor(Math.random() * 2500)) * 86400000);
});
after(async () => {
  await srv.close();
  await finish();
});

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(srv.baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const ymd = (d) => d.toISOString().slice(0, 10);
const at = (dayOffset, hhmm) => new Date(`${ymd(new Date(baseDay.getTime() + dayOffset * 86400000))}T${hhmm}:00Z`);

async function makeFlight({ from, to, departs, mins = 120, seats = 5, price = '3000.00' }) {
  const id = uniq();
  const arrives = new Date(departs.getTime() + mins * 60000);
  await pool.query(
    `INSERT INTO flights (flight_id, airline_id, flight_number, origin_airport_id, dest_airport_id, departs_at, arrives_at,
                          duration_minutes, stops, aircraft_type, cabin_classes, carbon_kg, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'A320','economy',10,'active',now())`,
    [`flt_t${id}`, airline, `TT-${id.slice(0, 4)}`, ap[from], ap[to], departs, arrives, mins],
  );
  await pool.query(
    `INSERT INTO flight_fares (fare_id, flight_id, cabin_class, fare_class, base_fare, taxes, currency, baggage_kg, cabin_baggage_kg,
                               changeable, change_fee, refundable, seats_total, status, updated_at)
     VALUES ($1,$2,'economy','standard',$3,0,'INR',15,7,true,0,false,$4,'active',now())`,
    [`far_t${id}`, `flt_t${id}`, price, seats],
  );
  const inv = `inv_t${id}`;
  await pool.query(
    `INSERT INTO inventory_calendar (inventory_id, entity_type, entity_id, for_date, total_units, booked_units, held_units, price,
                                     currency, min_stay_nights, closed_to_arrival, updated_at)
     VALUES ($1,'flight_fare',$2,$3::date,$4,0,0,$5,'INR',1,false,now())`,
    [inv, `far_t${id}`, ymd(departs), seats, price],
  );
  return { inv, fare: `far_t${id}`, flight: `TT-${id.slice(0, 4)}` };
}

const search = (day) => call('GET', `/api/search/flights?origin=Bengaluru&destination=Jaipur&date=${ymd(new Date(baseDay.getTime() + day * 86400000))}&seats=1`);

test('a connection is offered only when the layover is 60-360 min and the second leg leaves the airport the first landed at', async () => {
  const d = 1;
  const leg1 = await makeFlight({ from: 'BEN', to: 'NEW', departs: at(d, '06:00'), mins: 180, price: '4000.00' }); // lands 09:00
  const good = await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '10:30'), mins: 70, price: '2500.00' }); // 90 min layover
  const tight = await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '09:30'), mins: 70 }); // 30 min: too tight
  const long = await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '16:00'), mins: 70 }); // 7 h: too long
  const otherAirport = await makeFlight({ from: 'NEZ', to: 'JAI', departs: at(d, '11:00'), mins: 70 }); // Delhi, but another airport
  await makeFlight({ from: 'BEN', to: 'NEW', departs: at(d, '20:00'), mins: 180 }); // lands 23:00
  const late = await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d + 1, '01:00'), mins: 70, price: '2600.00' }); // overnight, 2 h layover: allowed

  const r = await search(d);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0, 'no direct flight');
  const got = r.body.connections;
  const legOf = (c) => c.legs[1].flight.flight_number;
  assert.deepEqual(got.map(legOf).sort(), [good.flight, late.flight].sort(), 'only the two valid second legs');
  for (const bad of [tight, long, otherAirport]) assert.ok(!got.some((c) => legOf(c) === bad.flight), `${bad.flight} must not be offered`);

  const c = got.find((x) => legOf(x) === good.flight);
  assert.equal(c.hub.iata, 'NEW');
  assert.equal(c.layover_minutes, 90);
  assert.equal(c.total_duration_minutes, 180 + 90 + 70);
  assert.equal(c.price.amount, '6500.00', 'total is the sum of both legs');
  assert.deepEqual(c.inventory_ids, [leg1.inv, good.inv]);
  assert.equal(c.stays.length, 2);
  assert.equal(got[0].price.amount, '5600.00', 'cheapest first (the overnight pair)');
});

test('a connection needs enough seats on BOTH legs, and connections=false skips them', async () => {
  const d = 5;
  await makeFlight({ from: 'BEN', to: 'NEW', departs: at(d, '06:00'), mins: 180, seats: 4 });
  await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '10:30'), mins: 70, seats: 1 });
  const one = await search(d);
  assert.equal(one.body.connections.length, 1);
  assert.equal(one.body.connections[0].available_seats, 1);

  const two = await call('GET', `/api/search/flights?origin=Bengaluru&destination=Jaipur&date=${ymd(at(d, '00:00'))}&seats=2`);
  assert.equal(two.body.connections.length, 0, '2 seats do not fit on the 1-seat leg');

  const off = await call('GET', `/api/search/flights?origin=Bengaluru&destination=Jaipur&date=${ymd(at(d, '00:00'))}&seats=1&connections=false`);
  assert.deepEqual(off.body.connections, []);
});

test('the two legs are held together: one request takes both seats, and when one leg is gone nothing is held', async () => {
  const [u1, u2] = await testUsers();
  const d = 9;
  const a = await makeFlight({ from: 'BEN', to: 'NEW', departs: at(d, '06:00'), mins: 180, seats: 5 });
  const b = await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '10:30'), mins: 70, seats: 1 }); // the scarce leg
  const [c] = (await search(d)).body.connections;
  assert.deepEqual(c.inventory_ids, [a.inv, b.inv]);

  const items = c.stays.map((s) => ({ entity_type: s.entity_type, entity_id: s.entity_id, for_date: s.for_date, nights: 1, units: 1 }));
  const first = await call('POST', '/api/holds', { user_id: u1.user_id, items }, { 'Idempotency-Key': `conn_${uniq()}` });
  assert.equal(first.status, 201);
  assert.equal(first.body.holds.length, 2);
  assert.equal(new Set(first.body.holds.map((h) => h.expires_at)).size, 1, 'one shared deadline');
  assert.equal((await readInventory(a.inv)).held_units, 1);
  assert.equal((await readInventory(b.inv)).held_units, 1);

  // A second traveller wants the same connection: the scarce leg is gone, so the plentiful leg must not be held either.
  const second = await call('POST', '/api/holds', { user_id: u2.user_id, items }, { 'Idempotency-Key': `conn_${uniq()}` });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'sold_out');
  assert.equal((await readInventory(a.inv)).held_units, 1, 'the first leg is untouched by the refused request');
  assert.equal((await readInventory(b.inv)).held_units, 1);

  // And the connection no longer appears in search.
  assert.equal((await search(d)).body.connections.length, 0);
});

test('routes: a city pair that is reachable only with one stop is offered, with the dates it works on', async () => {
  const d = 13;
  await makeFlight({ from: 'BEN', to: 'NEW', departs: at(d, '06:00'), mins: 180 });
  await makeFlight({ from: 'NEW', to: 'JAI', departs: at(d, '10:30'), mins: 70 });
  const { body } = await call('GET', '/api/flights/routes?destination=Jaipur&origin=Bengaluru');
  const route = body.routes.find((r) => r.origin === 'Bengaluru' && r.destination === 'Jaipur');
  assert.ok(route, 'Bengaluru -> Jaipur is offered');
  assert.ok(route.dates.includes(ymd(at(d, '00:00'))), 'including the date of the connection');
});
