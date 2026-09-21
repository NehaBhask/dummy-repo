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
  r.get('/invariants', async (_req, res) => res.json(await checkInvariants()));

  r.get('/cities', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT city_id, name, state, country_code FROM cities WHERE status = 'active' ORDER BY name`,
    );
    res.json({ cities: rows });
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
