import { Router } from 'express';
import { pool } from './db.js';
import { config } from './config.js';
import { AppError, localise, metrics, statusOf } from './errors.js';
import { convert, fxContext } from './fx.js';
import { money } from './money.js';
import {
  aiSearchBody, bookingBody, cancelBody, flightQuery, holdBody, hotelQuery, idempotencyKey, loadTestBody, parse,
} from './validation.js';
import { demoUser } from './modules/users.js';
import { checkInvariants } from './modules/invariants.js';
import { getInventory, resolveHoldItems } from './modules/inventory/availability.js';
import { findContendedInventory, searchFlights, searchHotels } from './modules/inventory/search.js';
import { createHold, getHold, releaseHold } from './modules/booking/holds.js';
import { cancelBooking, confirmBooking, getBooking, listBookings } from './modules/booking/bookings.js';
import { aiSearch } from './modules/ai/search.js';
import { getRun, listRuns, publicRun, runLoadTest, startLoadTest } from './modules/loadtest/engine.js';

export function buildRouter({ worker } = {}) {
  const r = Router();

  const userIdOf = async (body) => body.user_id ?? (await demoUser()).user_id;
  const keyOf = (req, body) => {
    const raw = req.get('idempotency-key') ?? body.idempotency_key;
    if (!raw) {
      throw new AppError('validation_error', { details: { idempotency_key: 'required (Idempotency-Key header or body field)' } });
    }
    return parse(idempotencyKey, raw);
  };
  const replayHeader = (res, replayed) => res.set('Idempotent-Replayed', replayed ? 'true' : 'false');

  /* ------------------------------ meta -------------------------------- */
  r.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      expiry_worker: worker?.state ?? 'disabled',
    });
  });
  r.get('/metrics', (_req, res) => res.json({ safety_net_hits: metrics.safetyNetHits, sold_out_shield: config.fastReject && config.soldOutCacheMs > 0 }));
  r.get('/demo-user', async (_req, res) => res.json(await demoUser()));

  // Everything the UI needs to configure itself in one call.
  r.get('/meta', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT min(for_date)::text AS from_date, max(for_date)::text AS to_date, CURRENT_DATE::text AS today
         FROM inventory_calendar`,
    );
    const w = rows[0];
    const tomorrow = new Date(Date.parse(`${w.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const dflt = tomorrow < w.from_date ? w.from_date : tomorrow > w.to_date ? w.from_date : tomorrow;
    res.json({
      today: w.today,
      inventory_window: { from: w.from_date, to: w.to_date },
      default_check_in: dflt,
      user: await demoUser(),
      ai_search: { enabled: Boolean(config.gemini.apiKey), fallback: 'english-only heuristic' },
      demo_controls: config.faultInjection, // fault injection + short hold TTLs are offered only outside production
      hold_ttl_seconds: config.holdTtlSeconds,
    });
  });
  r.get('/invariants', async (_req, res) => res.json(await checkInvariants()));

  // `bookable` = the city has room-night inventory (only 43 of 60 do), so the UI can steer users
  // away from cities that would always return nothing.
  r.get('/cities', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT c.city_id, c.name, c.state, c.country_code,
              COALESCE(b.room_nights, 0)::int AS room_nights,
              (b.room_nights IS NOT NULL) AS bookable
         FROM cities c
         LEFT JOIN (
           SELECT h.city_id, count(*) AS room_nights
             FROM inventory_calendar ic
             JOIN hotel_room_types rt ON rt.room_type_id = ic.entity_id
             JOIN hotels h ON h.hotel_id = rt.hotel_id
            WHERE ic.entity_type = 'room_type' AND ic.for_date >= CURRENT_DATE
            GROUP BY h.city_id
         ) b ON b.city_id = c.city_id
        WHERE c.status = 'active'
        ORDER BY (b.room_nights IS NULL), c.name`,
    );
    res.json({ cities: rows });
  });

  // Origin → destination pairs that have flight seats, with the departure dates that have any.
  r.get('/flights/routes', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT oc.name AS origin, dc.name AS destination,
              array_agg(DISTINCT ic.for_date::text ORDER BY ic.for_date::text) AS dates
         FROM inventory_calendar ic
         JOIN flight_fares ff ON ff.fare_id = ic.entity_id
         JOIN flights f ON f.flight_id = ff.flight_id
         JOIN airports oa ON oa.airport_id = f.origin_airport_id
         JOIN cities oc ON oc.city_id = oa.city_id
         JOIN airports da ON da.airport_id = f.dest_airport_id
         JOIN cities dc ON dc.city_id = da.city_id
        WHERE ic.entity_type = 'flight_fare' AND ic.for_date >= CURRENT_DATE
          AND ic.total_units - ic.booked_units - ic.held_units >= 1
          AND ($1::text IS NULL OR lower(dc.name) = lower($1))
          AND ($2::text IS NULL OR lower(oc.name) = lower($2))
        GROUP BY oc.name, dc.name
        ORDER BY count(DISTINCT ic.for_date) DESC, oc.name, dc.name
        LIMIT 80`,
      [req.query.destination ?? null, req.query.origin ?? null],
    );
    res.json({ routes: rows });
  });

  r.get('/currencies', async (_req, res) => {
    const fx = await fxContext();
    res.json({ rate_date: fx.rateDate, currencies: Object.values(fx.currencies) });
  });

  r.get('/fx', async (req, res) => {
    const { from, to } = req.query;
    const amount = money(req.query.amount ?? '1');
    if (!/^[A-Z]{3}$/.test(from ?? '') || !/^[A-Z]{3}$/.test(to ?? '')) {
      throw new AppError('validation_error', { details: { from_to: 'expected ISO-4217 codes' } });
    }
    const fx = await fxContext();
    res.json({ from, to, amount, converted: convert(fx, amount, from, to), rate_date: fx.rateDate });
  });

  /* ---------------------------- inventory ----------------------------- */
  r.get('/inventory/contended', async (req, res) => {
    res.json({ inventory: await findContendedInventory(Math.min(Number(req.query.limit) || 20, 50)) });
  });
  r.get('/inventory/:id', async (req, res) => res.json(await getInventory(req.params.id)));

  /* ------------------------------ search ------------------------------ */
  r.get('/search/hotels', async (req, res) => res.json(await searchHotels(parse(hotelQuery, req.query))));
  r.get('/search/flights', async (req, res) => res.json(await searchFlights(parse(flightQuery, req.query))));
  r.post('/search/ai', async (req, res) => res.json(await aiSearch(parse(aiSearchBody, req.body))));

  /* ------------------------------ holds ------------------------------- */
  r.post('/holds', async (req, res) => {
    const b = parse(holdBody, req.body);
    const key = keyOf(req, b);
    const items = await resolveHoldItems(b.items);
    // Load tests send X-Bypass-Shield: 1 so every request hits Postgres' row lock (dev/demo only).
    const bypassShield = config.faultInjection && req.get('x-bypass-shield') === '1';
    const out = await createHold({ userId: await userIdOf(b), items, idempotencyKey: key, ttlSeconds: b.ttl_seconds, bypassShield });
    replayHeader(res, out.replayed)
      .status(out.replayed ? 200 : 201)
      .json({
        replayed: out.replayed,
        expires_at: out.holds.map((h) => h.expires_at).sort()[0],
        holds: out.holds,
      });
  });
  r.get('/holds/:id', async (req, res) => res.json(await getHold(req.params.id, { userId: req.query.user_id })));
  r.post('/holds/:id/release', async (req, res) => {
    res.json(await releaseHold({ holdId: req.params.id, userId: req.body?.user_id }));
  });

  /* ----------------------------- bookings ----------------------------- */
  r.post('/bookings', async (req, res) => {
    const b = parse(bookingBody, req.body);
    const out = await confirmBooking({
      userId: await userIdOf(b),
      idempotencyKey: keyOf(req, b),
      items: b.items ?? b.hold_ids.map((hold_id) => ({ hold_id })),
      currency: b.currency,
      method: b.payment?.method,
      channel: b.channel,
      simulate: b.simulate_failure,
    });
    replayHeader(res, out.replayed);

    if (out.outcome === 'confirmed') {
      return res.status(out.replayed ? 200 : 201).json({ replayed: out.replayed, booking: out.booking });
    }
    if (out.outcome === 'incomplete') {
      return res.status(500).json({
        error: { code: 'compensation_incomplete', message: localise('compensation_incomplete', req.lang) },
        booking: out.booking,
      });
    }
    // Saga failed and was rolled back: report the cause, and show the compensated lines.
    const code = out.failure?.code ?? 'booking_failed';
    res.status(statusOf(code)).json({
      error: {
        code,
        message: localise(code, req.lang),
        rolled_back: true,
        details: out.failure?.details,
      },
      replayed: out.replayed,
      booking: out.booking,
    });
  });

  r.get('/bookings', async (req, res) => {
    const userId = req.query.user_id ?? (await demoUser()).user_id;
    res.json({ bookings: await listBookings({ userId, status: req.query.status, limit: Math.min(Number(req.query.limit) || 50, 200) }) });
  });
  r.get('/bookings/:id', async (req, res) => res.json(await getBooking(req.params.id, { userId: req.query.user_id })));
  r.post('/bookings/:id/cancel', async (req, res) => {
    const b = parse(cancelBody, req.body ?? {});
    const out = await cancelBooking({ bookingId: req.params.id, userId: b.user_id, reason: b.reason });
    res.json({ already_cancelled: out.already, restocked_units: out.restocked_units ?? 0, booking: out.booking });
  });

  /* ---------------------------- load tests ---------------------------- */
  r.post('/loadtests', async (req, res) => {
    const { wait, ...opts } = parse(loadTestBody, req.body ?? {});
    const ctx = { baseUrl: req.app.locals.baseUrl };
    if (wait) return res.json(await runLoadTest(opts, ctx));
    res.status(202).json(publicRun(await startLoadTest(opts, ctx)));
  });
  r.get('/loadtests', async (req, res) => res.json({ runs: await listRuns(Math.min(Number(req.query.limit) || 20, 100)) }));
  r.get('/loadtests/:id', async (req, res) => res.json(await getRun(req.params.id)));

  return r;
}
