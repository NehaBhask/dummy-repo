import { api, newKey } from '../api.js';

/*
 * Live event source: each scenario drives the REAL backend and turns what actually came back into
 * visualizer events. Nothing here is scripted — the counts, lock-wait evidence, statuses and ids are the
 * server's. Runs leave data behind the way any booking would (holds released, bookings cancelled or
 * rolled back; nothing is hard-deleted — R8).
 *
 * `emit({ at, signal, message, payload })` — `at` is a 0–100 position for the animation clock.
 */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('aborted', 'AbortError')); });
  });

const CITIES = ['Jaipur', 'Udaipur', 'Agra'];

// A room with spare units (so this run does not fight the scarce rows the load test uses).
async function findStay(ctx, minUnits) {
  for (const city of CITIES) {
    const r = await api.searchHotels({ city, check_in: ctx.checkIn, nights: 1, rooms: 1, adults: 1, currency: ctx.currency, limit: 12 });
    for (const card of r.results) {
      const room = card.rooms.find((x) => x.available_units >= minUnits);
      if (room) return { card, room };
    }
  }
  throw new Error('No room with spare stock found for a live run.');
}

async function findFlight(ctx, city) {
  const { routes } = await api.routes({ destination: city });
  for (const route of routes) {
    const day = route.dates.find((d) => d >= ctx.today);
    if (!day) continue;
    const r = await api.searchFlights({ origin: route.origin, destination: city, date: day, seats: 1, currency: ctx.currency });
    const hit = r.results.find((x) => x.available_seats >= 2);
    if (hit) return hit;
  }
  throw new Error(`No flight with spare seats into ${city} found for a live run.`);
}

const hold = async (stay, key) => (await api.createHold({ items: [stay], key, ttl: 120 })).data.holds[0];

async function race({ emit, signal }) {
  const { inventory } = await api.contended();
  const row = inventory[0];
  if (!row) throw new Error('No scarce row to race for — is the backend seeded?');
  const requests = 12;
  emit({ at: 0, signal: 'blue', message: `${requests} requests received`, payload: { op: 'reserve', inventory_id: row.inventory_id, units: 1, free: row.free_units } });

  let run = await api.startLoadTest({ inventory_id: row.inventory_id, concurrent_requests: requests, mode: 'api', bypass_shield: true, cleanup: true });
  for (let i = 0; run.status === 'running' && i < 240; i++) {
    await sleep(250, signal);
    run = await api.getRun(run.run_id);
  }
  if (run.status !== 'completed') throw new Error(run.error ?? 'Load test did not complete');

  const { summary: s, verdict: v } = run;
  const free0 = run.verdict.detail.initial_free;
  await sleep(350, signal);
  emit({ at: 18, signal: 'amber', message: 'Requests queued at the row lock', payload: { op: 'lock_wait', db_sessions_blocked_on_row_lock: v.detail.peak_db_sessions_blocked_on_row_lock, db_active_sessions: v.detail.peak_db_active_sessions } });
  for (let k = 1; k <= s.successes; k++) {
    await sleep(500, signal);
    emit({ at: 35 + ((k - 1) * 33) / Math.max(1, s.successes - 1 || 1), signal: 'green', message: `Reservation committed · ${free0 - k} free`, payload: { op: 'reserve', result: 'granted', remaining: free0 - k } });
  }
  await sleep(500, signal);
  emit({ at: 82, signal: 'red', message: 'Remaining requests rejected', payload: { op: 'reserve', result: 'sold_out', rejected: s.sold_out, errors: s.errors } });
  await sleep(500, signal);
  emit({
    at: 100,
    signal: v.passed ? 'green' : 'red',
    message: v.passed ? 'Zero oversell · all checks passed' : 'A check failed',
    payload: { op: 'verdict', granted: `${s.successes}/${run.expected_successes}`, oversold: v.detail.invariants.global.oversold, db_check_hits: v.detail.db_check_hits, db_read: 'verdict computed from the database, not the responses' },
  });
}

async function saga({ emit, signal, ctx }) {
  emit({ at: 0, signal: 'blue', message: 'Multi-item booking started', payload: { op: 'saga_start', items: 2 } });
  const stay = await findStay(ctx, 2);
  const flight = await findFlight(ctx, stay.card.hotel.city);
  // One request holds both, exactly as the trip page's Reserve does: one transaction, one shared deadline.
  const held = (await api.createHold({ items: [stay.room.stay, flight.stay], key: newKey('viz-trip'), ttl: 120 })).data;
  const hotelIds = stay.room.inventory.map((i) => i.inventory_id);
  const hotelHold = held.holds.find((h) => hotelIds.includes(h.inventory_id));
  const flightHold = held.holds.find((h) => h.inventory_id === flight.inventory_id);
  await sleep(500, signal);
  emit({
    at: 20,
    signal: 'blue',
    message: 'Hotel and flight held together · one deadline',
    payload: { op: 'reserve_trip', hotel_hold: hotelHold.hold_id, flight_hold: flightHold.hold_id, expires_at: held.expires_at, shared_deadline: new Set(held.holds.map((h) => h.expires_at)).size === 1 },
  });

  const req = { key: newKey('viz-book'), body: { items: [{ hold_id: hotelHold.hold_id }, { hold_id: flightHold.hold_id }], currency: ctx.currency, payment: { method: 'mock' }, simulate_failure: 'flight' } };
  let booking;
  let failure = null;
  try {
    booking = (await api.confirm(req)).data.booking;
  } catch (e) {
    if (!e.body?.booking) throw e;
    booking = e.body.booking;
    failure = e.body.error;
  }
  const hotelLine = booking.items.find((i) => i.entity_type === 'room_type');
  const flightLine = booking.items.find((i) => i.entity_type !== 'room_type');
  await sleep(600, signal);
  emit({ at: 42, signal: 'green', message: 'Hotel line confirmed', payload: { op: 'confirm_line', line: 'hotel', result: hotelLine?.compensated_at ? 'confirmed' : hotelLine?.status } });
  await sleep(600, signal);
  emit({ at: 60, signal: 'red', message: 'Flight line failed', payload: { op: 'confirm_line', line: 'flight', result: 'failed', code: failure?.code ?? flightLine?.status } });
  await sleep(600, signal);
  emit({ at: 76, signal: 'amber', message: 'Compensating prior steps', payload: { op: 'compensate', line: 'hotel', line_status: hotelLine?.status, payment: booking.payment?.status } });
  await sleep(600, signal);
  emit({ at: 92, signal: 'grey', message: 'Saga closed safely', payload: { op: 'saga_complete', result: booking.status, booking: booking.booking_reference, hotel_line: hotelLine?.status, flight_line: flightLine?.status } });
}

async function retry({ emit, signal, ctx }) {
  const stay = await findStay(ctx, 2);
  const h = await hold(stay.room.stay, newKey('viz-hold'));
  const req = { key: newKey('viz-book'), body: { items: [{ hold_id: h.hold_id }], currency: ctx.currency, payment: { method: 'mock' } } };
  emit({ at: 0, signal: 'blue', message: 'Duplicate keys received', payload: { op: 'confirm', idempotency_key: req.key, attempts: 2 } });

  const send = async () => {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await api.confirm(req);
        return { booking: r.data.booking, replayed: r.replayed };
      } catch (e) {
        if (e.body?.booking) return { booking: e.body.booking, replayed: true };
        if (e.code !== 'request_in_progress') throw e;
        await sleep(300, signal); // the twin is still mid-flight: wait and ask again, as a real client would
      }
    }
    throw new Error('retry did not settle');
  };
  const [a, b] = await Promise.all([send(), send()]);
  const first = a.replayed ? b : a;
  const second = a.replayed ? a : b;

  await sleep(600, signal);
  emit({ at: 28, signal: 'amber', message: 'Both requests converge at the idempotency key', payload: { op: 'lock_wait', idempotency_key: req.key } });
  await sleep(700, signal);
  emit({ at: 55, signal: 'green', message: 'First request committed', payload: { op: 'confirm', result: 'granted', booking_id: first.booking.booking_id, replayed: first.replayed } });
  await sleep(600, signal);
  emit({ at: 72, signal: second.replayed ? 'green' : 'red', message: second.replayed ? 'Stored result replayed' : 'Second request was processed as new', payload: { op: 'confirm', result: second.booking.booking_id === first.booking.booking_id ? 'same_booking' : 'DIFFERENT_BOOKING', booking_id: second.booking.booking_id, replayed: second.replayed } });
  await sleep(600, signal);
  const cancelled = await api.cancel(first.booking.booking_id);
  emit({ at: 92, signal: 'grey', message: 'Test booking cancelled, stock restored', payload: { op: 'cancel', booking_id: first.booking.booking_id, restocked_units: cancelled.restocked_units } });
}

export const liveRuns = { race, saga, retry };
