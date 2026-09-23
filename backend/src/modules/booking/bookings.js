import { pool, withTx, lockInventory } from '../../db.js';
import { config } from '../../config.js';
import { AppError, fromPgError } from '../../errors.js';
import { newId, newBookingReference } from '../../ids.js';
import { D, money, sum, withTax } from '../../money.js';
import { fxContext, convert, assertCurrency } from '../../fx.js';
import { describeInventory, inventoryTitle } from '../inventory/availability.js';
import { authoriseAndCapture } from '../payment/mock.js';
import { clearSoldOut } from '../inventory/soldout.js';

/*
 * Booking confirmation as a saga.
 *
 *   claim      one txn: INSERT booking(pending) ON CONFLICT (idempotency_key) DO NOTHING,
 *              plus its pending lines and an 'initiated' payment. Whoever's insert returns a
 *              row owns the saga; everyone else is a retry and gets the stored outcome.
 *   for each line, in a fixed order (hotel before flight, then inventory_id):
 *              local txn: lock hold → lock inventory → held→booked → mark line confirmed
 *   pivot      mock payment, outside any transaction
 *   finalise   one txn: payment captured + booking confirmed
 *   on any failure: compensate every line (confirmed → restock booked units; unconfirmed →
 *              release the hold), booking → failed, payment → failed. Each compensation is its
 *              own idempotent txn and is retried; if one still fails the booking is parked as
 *              'partially_confirmed' (compensation incomplete) rather than lying about its state.
 *
 * Each step commits on its own, so no transaction ever spans two inventory rows: cross-item
 * deadlock is impossible by construction, and the fixed ordering keeps every path predictable.
 */

const TYPE_RANK = { room_type: 0, flight_fare: 1 };
const PAYMENT_FAILURE_CODES = new Set([
  'hold_expired', 'sold_out', 'over_budget', 'invalid_id', 'currency_mismatch',
  'idempotency_conflict', 'constraint_infeasible', 'low_confidence',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await sleep(40 * 2 ** i);
    }
  }
}

const BOOKING_COLS = `booking_id, user_id, booking_reference, channel, total_amount, currency, tax_amount,
  idempotency_key, status, confirmed_at, cancelled_at, cancellation_reason, created_at, updated_at`;

export async function getBooking(bookingId, { userId } = {}) {
  const b = (await pool.query(`SELECT ${BOOKING_COLS} FROM bookings WHERE booking_id = $1`, [bookingId])).rows[0];
  if (!b) throw new AppError('invalid_id', { details: { booking_id: bookingId } });
  if (userId && b.user_id !== userId) throw new AppError('forbidden');
  const [full] = await hydrate([b]);
  return full;
}

export async function listBookings({ userId, status, limit = 50 }) {
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings
      WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [userId, status ?? null, limit],
  );
  return hydrate(rows);
}

async function hydrate(bookings) {
  if (!bookings.length) return [];
  const ids = bookings.map((b) => b.booking_id);
  const [items, pays, fx] = await Promise.all([
    pool.query(
      `SELECT booking_item_id, booking_id, entity_type, entity_id, inventory_id, hold_id, title,
              for_date::text AS for_date, units, unit_price, line_total, currency, status, compensated_at
         FROM booking_items WHERE booking_id = ANY($1::text[]) ORDER BY for_date, inventory_id, booking_item_id`,
      [ids],
    ),
    pool.query(
      `SELECT payment_id, booking_id, method, status, authorised_amount, captured_amount, refunded_amount,
              currency, gateway_reference, failure_code, authorised_at, captured_at
         FROM payments WHERE booking_id = ANY($1::text[])`,
      [ids],
    ),
    fxContext(),
  ]);
  return bookings.map((b) => {
    const meta = fx.currencies[b.currency];
    return {
      ...b,
      failure: b.status === 'failed' ? parseReason(b.cancellation_reason) : null,
      payment: pays.rows.find((p) => p.booking_id === b.booking_id) ?? null,
      items: items.rows.filter((i) => i.booking_id === b.booking_id),
      display: {
        total: fmt(b.total_amount, meta),
        tax: fmt(b.tax_amount, meta),
      },
    };
  });
}

const fmt = (amount, meta) =>
  meta
    ? new Intl.NumberFormat(meta.display_locale, {
        style: 'currency',
        currency: meta.iso4217,
        minimumFractionDigits: meta.minor_unit_exponent,
        maximumFractionDigits: meta.minor_unit_exponent,
      }).format(Number(amount)) // display only
    : amount;

// cancellation_reason for failed bookings is "<error_code>[:<hint>]"
function parseReason(reason) {
  if (!reason) return null;
  const [code, ...rest] = reason.split(':');
  return { code, hint: rest.join(':') || undefined };
}

/* ------------------------------------------------------------------------------------------ */
/* confirm                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * @param {{ userId: string, idempotencyKey: string, items: {hold_id: string, rate_plan_id?: string}[],
 *           currency?: string, method?: string, channel?: string, simulate?: 'flight'|'hotel'|'payment' }} input
 * @returns {Promise<{ outcome: 'confirmed'|'failed'|'incomplete', booking: object, replayed: boolean, failure?: object }>}
 */
export async function confirmBooking(input) {
  if (input.simulate && !config.faultInjection) {
    throw new AppError('validation_error', { details: { simulate_failure: 'fault injection is disabled' } });
  }

  const existing = await findByKey(input.idempotencyKey);
  if (existing) return replay(existing, input);

  const prepared = await prepare(input);
  const claimed = await claimBooking(input, prepared);
  if (!claimed.owned) return replay(await findByKey(input.idempotencyKey), input);

  const ctx = { ...prepared, bookingId: claimed.bookingId, input };
  return runSaga(ctx);
}

async function findByKey(key) {
  const b = (await pool.query(`SELECT ${BOOKING_COLS} FROM bookings WHERE idempotency_key = $1`, [key])).rows[0];
  return b ?? null;
}

async function replay(b, input) {
  const { rows } = await pool.query('SELECT hold_id FROM booking_items WHERE booking_id = $1', [b.booking_id]);
  const same =
    b.user_id === input.userId &&
    new Set(rows.map((r) => r.hold_id)).size === input.items.length &&
    input.items.every((i) => rows.some((r) => r.hold_id === i.hold_id));
  if (!same) throw new AppError('idempotency_conflict', { details: { reason: 'key was used for a different booking' } });

  if (b.status === 'pending') {
    throw new AppError('request_in_progress', { details: { booking_id: b.booking_id } });
  }
  const booking = await getBooking(b.booking_id);
  const outcome = b.status === 'failed' ? 'failed' : b.status === 'partially_confirmed' ? 'incomplete' : 'confirmed';
  return { outcome, booking, replayed: true, failure: booking.failure ?? undefined };
}

/** Read-only validation and pricing. Nothing is written until claim(). */
async function prepare(input) {
  const holdIds = input.items.map((i) => i.hold_id);
  if (new Set(holdIds).size !== holdIds.length) {
    throw new AppError('validation_error', { details: { hold_id: 'duplicate hold in booking' } });
  }

  const [{ rows: holds }, fx] = await Promise.all([
    pool.query(
      `SELECT hold_id, user_id, units, inventory_id FROM holds WHERE hold_id = ANY($1::text[])`,
      [holdIds],
    ),
    fxContext(),
  ]);
  const found = new Map(holds.map((h) => [h.hold_id, h]));
  for (const id of holdIds) if (!found.has(id)) throw new AppError('invalid_id', { details: { hold_id: id } });
  for (const h of holds) if (h.user_id !== input.userId) throw new AppError('forbidden');

  const inv = await describeInventory(holds.map((h) => h.inventory_id));

  const planIds = input.items.map((i) => i.rate_plan_id).filter(Boolean);
  const plans = new Map();
  if (planIds.length) {
    const { rows } = await pool.query(
      `SELECT rate_plan_id, room_type_id, name, price_delta, currency
         FROM hotel_rate_plans WHERE rate_plan_id = ANY($1::text[]) AND status = 'active'`,
      [planIds],
    );
    for (const p of rows) plans.set(p.rate_plan_id, p);
  }

  const user = (await pool.query('SELECT home_currency FROM users WHERE user_id = $1', [input.userId])).rows[0];
  if (!user) throw new AppError('invalid_id', { details: { user_id: input.userId } });

  const currencies = new Set(holds.map((h) => inv.get(h.inventory_id).currency));
  const currency = input.currency ?? (currencies.size === 1 ? [...currencies][0] : user.home_currency);
  assertCurrency(fx, currency);

  const lines = input.items.map((it) => {
    const h = found.get(it.hold_id);
    const i = inv.get(h.inventory_id);
    let delta = '0.00';
    let planName = null;
    if (it.rate_plan_id) {
      const p = plans.get(it.rate_plan_id);
      if (!p || i.entity_type !== 'room_type' || p.room_type_id !== i.entity_id) {
        throw new AppError('invalid_id', { details: { rate_plan_id: it.rate_plan_id } });
      }
      if (p.currency !== i.currency) throw new AppError('currency_mismatch', { details: { rate_plan_id: p.rate_plan_id } });
      delta = p.price_delta;
      planName = p.name;
    }
    return {
      hold_id: h.hold_id,
      units: h.units,
      inventory_id: h.inventory_id,
      entity_type: i.entity_type,
      entity_id: i.entity_id,
      for_date: i.for_date,
      title: planName ? `${inventoryTitle(i)} — ${planName}` : inventoryTitle(i),
      native_currency: i.currency,
      plan_delta: delta,
      ...price(fx, currency, i.price, delta, i.currency, h.units),
    };
  });
  lines.sort(
    (a, b) =>
      (TYPE_RANK[a.entity_type] ?? 9) - (TYPE_RANK[b.entity_type] ?? 9) ||
      (a.inventory_id < b.inventory_id ? -1 : a.inventory_id > b.inventory_id ? 1 : a.hold_id < b.hold_id ? -1 : 1),
  );

  return { fx, currency, lines, estimate: withTax(sum(lines.map((l) => l.line_total))) };
}

function price(fx, currency, nativePrice, delta, nativeCurrency, units) {
  const unit_price = convert(fx, D(nativePrice).plus(delta).toFixed(2), nativeCurrency, currency);
  return { unit_price, line_total: money(D(unit_price).mul(units)) };
}

async function claimBooking(input, { currency, lines, estimate }) {
  return withTx(async (c) => {
    const bookingId = newId('bkg');
    let inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      await c.query('SAVEPOINT ref');
      try {
        inserted = await c.query(
          `INSERT INTO bookings (booking_id, user_id, booking_reference, channel, total_amount, currency,
                                 tax_amount, idempotency_key, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', statement_timestamp(), statement_timestamp())
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING booking_id`,
          [bookingId, input.userId, newBookingReference(), input.channel ?? 'web',
           estimate.total, currency, estimate.tax, input.idempotencyKey],
        );
        await c.query('RELEASE SAVEPOINT ref');
      } catch (err) {
        if (err.code === '23505' && /booking_reference/.test(err.constraint ?? '')) {
          await c.query('ROLLBACK TO SAVEPOINT ref'); // 6-hex reference collided; draw another
          continue;
        }
        throw err;
      }
    }
    if (!inserted || inserted.rowCount === 0) return { owned: false };

    await c.query(
      `INSERT INTO booking_items (booking_item_id, booking_id, entity_type, entity_id, inventory_id, title,
                                  for_date, units, unit_price, line_total, currency, status, updated_at, hold_id)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                            $7::date[], $8::int[], $9::numeric[], $10::numeric[], $11::text[], $12::text[],
                            $13::timestamptz[], $14::text[])`,
      [
        lines.map(() => newId('bit')),
        lines.map(() => bookingId),
        lines.map((l) => l.entity_type),
        lines.map((l) => l.entity_id),
        lines.map((l) => l.inventory_id),
        lines.map((l) => l.title),
        lines.map((l) => l.for_date),
        lines.map((l) => l.units),
        lines.map((l) => l.unit_price),
        lines.map((l) => l.line_total),
        lines.map(() => currency),
        lines.map(() => 'pending'),
        lines.map(() => new Date()),
        lines.map((l) => l.hold_id),
      ],
    );
    await c.query(
      `INSERT INTO payments (payment_id, booking_id, method, status, authorised_amount, captured_amount,
                             refunded_amount, currency, gateway_reference, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, 'initiated', $4, 0, 0, $5, $6, $7, statement_timestamp(), statement_timestamp())`,
      [newId('pay'), bookingId, input.method ?? 'mock', estimate.total, currency,
       `mock_${bookingId.slice(4)}`, `pidem_${input.idempotencyKey}`],
    );
    return { owned: true, bookingId };
  });
}

async function runSaga(ctx) {
  const confirmed = [];
  let failure = null;

  for (const line of ctx.lines) {
    try {
      confirmed.push(await confirmLine(ctx, line));
    } catch (err) {
      failure = describeFailure(err, line);
      break;
    }
  }

  let totals = null;
  if (!failure) {
    totals = withTax(sum(confirmed.map((l) => l.line_total)));
    const pay = await authoriseAndCapture({
      bookingId: ctx.bookingId,
      amount: totals.total,
      currency: ctx.currency,
      method: ctx.input.method ?? 'mock',
      simulate: ctx.input.simulate,
    });
    if (!pay.ok) {
      failure = { code: pay.failure_code, step: 'payment' };
    } else {
      try {
        await finalise(ctx.bookingId, totals, pay.gateway_reference);
      } catch (err) {
        failure = describeFailure(err, null, 'finalise');
      }
    }
  }

  if (failure) return compensate(ctx, failure);
  return { outcome: 'confirmed', booking: await getBooking(ctx.bookingId), replayed: false };
}

function describeFailure(err, line, step = 'item') {
  const e = err instanceof AppError ? err : fromPgError(err);
  if (e instanceof AppError) {
    return { code: e.code, step, hold_id: line?.hold_id, details: e.details, message: e.message };
  }
  console.error('[saga] unexpected failure:', err);
  return { code: 'internal_error', step, hold_id: line?.hold_id, message: err?.message };
}

/** Saga step: convert one hold into a confirmed booking line. Its own local transaction. */
async function confirmLine(ctx, line) {
  const sim = ctx.input.simulate;
  return withTx(async (c) => {
    if ((sim === 'flight' && line.entity_type === 'flight_fare') || (sim === 'hotel' && line.entity_type === 'room_type')) {
      throw new AppError('sold_out', { details: { simulated: true, inventory_id: line.inventory_id } });
    }

    // Lock order for every path that touches an existing hold: hold → inventory → booking line.
    const h = (
      await c.query(
        `SELECT hold_id, user_id, units, status, booking_id, inventory_id,
                expires_at <= statement_timestamp() AS past_deadline
           FROM holds WHERE hold_id = $1 FOR UPDATE`,
        [line.hold_id],
      )
    ).rows[0];
    if (!h) throw new AppError('invalid_id', { details: { hold_id: line.hold_id } });
    if (h.status === 'confirmed') throw new AppError('invalid_state', { details: { hold_id: h.hold_id, status: h.status } });
    // A hold past its deadline is dead even if the worker hasn't swept it yet.
    if (h.status !== 'active' || h.past_deadline) throw new AppError('hold_expired', { details: { hold_id: h.hold_id } });

    const [inv] = await lockInventory(c, [h.inventory_id]);
    if (!inv || inv.held_units < h.units) {
      throw new Error(`inventory ${h.inventory_id} does not account for hold ${h.hold_id}`);
    }
    await c.query(
      `UPDATE inventory_calendar
          SET held_units = held_units - $2, booked_units = booked_units + $2, updated_at = statement_timestamp()
        WHERE inventory_id = $1`,
      [h.inventory_id, h.units],
    );
    await c.query(
      `UPDATE holds SET status = 'confirmed', booking_id = $2, updated_at = statement_timestamp() WHERE hold_id = $1`,
      [h.hold_id, ctx.bookingId],
    );

    const p = price(ctx.fx, ctx.currency, inv.price, line.plan_delta, inv.currency, h.units);
    await c.query(
      `UPDATE booking_items
          SET status = 'confirmed', unit_price = $2, line_total = $3, updated_at = statement_timestamp()
        WHERE booking_id = $1 AND hold_id = $4`,
      [ctx.bookingId, p.unit_price, p.line_total, h.hold_id],
    );
    return { hold_id: h.hold_id, inventory_id: h.inventory_id, ...p };
  });
}

async function finalise(bookingId, totals, gatewayRef) {
  await withTx(async (c) => {
    const b = await c.query(
      `UPDATE bookings
          SET status = 'confirmed', total_amount = $2, tax_amount = $3,
              confirmed_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE booking_id = $1 AND status = 'pending'`,
      [bookingId, totals.total, totals.tax],
    );
    if (b.rowCount !== 1) throw new Error(`booking ${bookingId} was not pending at finalise`);
    await c.query(
      `UPDATE payments
          SET status = 'captured', authorised_amount = $2, captured_amount = $2, gateway_reference = $3,
              authorised_at = statement_timestamp(), captured_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE booking_id = $1`,
      [bookingId, totals.total, gatewayRef],
    );
  });
}

/* ------------------------------------------------------------------------------------------ */
/* compensation                                                                               */
/* ------------------------------------------------------------------------------------------ */

async function compensate(ctx, failure) {
  const { rows: lines } = await pool.query(
    `SELECT booking_item_id FROM booking_items WHERE booking_id = $1 ORDER BY inventory_id, booking_item_id`,
    [ctx.bookingId],
  );

  let incomplete = false;
  for (const l of lines) {
    try {
      await retry(() => compensateLine(ctx.bookingId, l.booking_item_id));
    } catch (err) {
      incomplete = true;
      console.error(`[saga] compensation of ${l.booking_item_id} (booking ${ctx.bookingId}) FAILED:`, err);
    }
  }

  const reason = failure.hold_id ? `${failure.code}:${failure.hold_id}` : `${failure.code}:${failure.step}`;
  if (incomplete) {
    await pool.query(
      `UPDATE bookings SET status = 'partially_confirmed', cancellation_reason = $2, updated_at = now() WHERE booking_id = $1`,
      [ctx.bookingId, `compensation_incomplete:${reason}`],
    );
    return { outcome: 'incomplete', booking: await getBooking(ctx.bookingId), replayed: false, failure };
  }

  await withTx(async (c) => {
    await c.query(
      `UPDATE bookings SET status = 'failed', cancellation_reason = $2, updated_at = statement_timestamp() WHERE booking_id = $1`,
      [ctx.bookingId, reason],
    );
    await c.query(
      `UPDATE payments SET status = 'failed', failure_code = $2, updated_at = statement_timestamp() WHERE booking_id = $1`,
      [ctx.bookingId, PAYMENT_FAILURE_CODES.has(failure.code) ? failure.code : null],
    );
  });
  return { outcome: 'failed', booking: await getBooking(ctx.bookingId), replayed: false, failure };
}

/** Undo one line. Idempotent: a line already compensated/cancelled is left alone. */
async function compensateLine(bookingId, itemId) {
  return withTx(async (c) => {
    const item0 = (
      await c.query('SELECT inventory_id, hold_id FROM booking_items WHERE booking_item_id = $1', [itemId])
    ).rows[0];

    // hold → inventory → line (same order as confirmLine)
    const hold = item0.hold_id
      ? (await c.query('SELECT hold_id, status, units, booking_id FROM holds WHERE hold_id = $1 FOR UPDATE', [item0.hold_id])).rows[0]
      : null;
    if (item0.inventory_id) {
      await lockInventory(c, [item0.inventory_id]);
      clearSoldOut([item0.inventory_id]); // this compensation frees units on that row
    }
    const item = (
      await c.query('SELECT status, units FROM booking_items WHERE booking_item_id = $1 FOR UPDATE', [itemId])
    ).rows[0];
    if (item.status === 'compensated' || item.status === 'cancelled') return 'already';

    if (item.status === 'confirmed') {
      // restock what this saga had converted to booked units
      await c.query(
        `UPDATE inventory_calendar SET booked_units = booked_units - $2, updated_at = statement_timestamp() WHERE inventory_id = $1`,
        [item0.inventory_id, item.units],
      );
      if (hold && hold.status === 'confirmed' && hold.booking_id === bookingId) {
        await c.query(
          `UPDATE holds SET status = 'released', released_at = statement_timestamp(), updated_at = statement_timestamp() WHERE hold_id = $1`,
          [hold.hold_id],
        );
      }
    } else if (hold && hold.status === 'active') {
      // never confirmed: give the still-live hold back
      await c.query(
        `UPDATE inventory_calendar SET held_units = held_units - $2, updated_at = statement_timestamp() WHERE inventory_id = $1`,
        [item0.inventory_id, hold.units],
      );
      await c.query(
        `UPDATE holds
            SET status = CASE WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE 'released' END,
                released_at = statement_timestamp(), updated_at = statement_timestamp()
          WHERE hold_id = $1`,
        [hold.hold_id],
      );
    }
    // (a hold that is expired/released already, or was confirmed by a different booking, is not ours to touch)

    await c.query(
      `UPDATE booking_items SET status = 'compensated', compensated_at = statement_timestamp(),
              updated_at = statement_timestamp() WHERE booking_item_id = $1`,
      [itemId],
    );
    return 'compensated';
  });
}

/* ------------------------------------------------------------------------------------------ */
/* cancellation                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Cancel a confirmed booking: every confirmed line's units go back to booked → free, the payment
 * is refunded, nothing is deleted (R8). One transaction, so it is all-or-nothing, and the booking
 * row lock makes concurrent double-cancels restock exactly once.
 */
export async function cancelBooking({ bookingId, userId, reason }) {
  const result = await withTx(async (c) => {
    const b = (
      await c.query(`SELECT booking_id, user_id, status FROM bookings WHERE booking_id = $1 FOR UPDATE`, [bookingId])
    ).rows[0];
    if (!b) throw new AppError('invalid_id', { details: { booking_id: bookingId } });
    if (userId && b.user_id !== userId) throw new AppError('forbidden');
    if (b.status === 'cancelled') return { already: true };
    if (b.status !== 'confirmed' && b.status !== 'partially_confirmed') {
      throw new AppError('invalid_state', { details: { status: b.status } });
    }

    const { rows: lines } = await c.query(
      `SELECT inventory_id, units FROM booking_items WHERE booking_id = $1 AND status = 'confirmed'`,
      [bookingId],
    );
    const perRow = new Map();
    for (const l of lines) perRow.set(l.inventory_id, (perRow.get(l.inventory_id) ?? 0) + l.units);

    await lockInventory(c, [...perRow.keys()]); // sorted
    clearSoldOut([...perRow.keys()]);
    if (perRow.size) {
      await c.query(
        `UPDATE inventory_calendar ic
            SET booked_units = ic.booked_units - u.n, updated_at = statement_timestamp()
           FROM unnest($1::text[], $2::int[]) AS u(id, n)
          WHERE ic.inventory_id = u.id`,
        [[...perRow.keys()], [...perRow.values()]],
      );
    }
    await c.query(
      `UPDATE booking_items SET status = 'cancelled', updated_at = statement_timestamp()
        WHERE booking_id = $1 AND status = 'confirmed'`,
      [bookingId],
    );
    await c.query(
      `UPDATE bookings
          SET status = 'cancelled', cancelled_at = statement_timestamp(), cancellation_reason = $2,
              updated_at = statement_timestamp()
        WHERE booking_id = $1`,
      [bookingId, reason ?? 'cancelled_by_user'],
    );
    await c.query(
      `UPDATE payments
          SET status = CASE status WHEN 'captured' THEN 'refunded' WHEN 'authorised' THEN 'voided' ELSE status END,
              refunded_amount = CASE status WHEN 'captured' THEN captured_amount ELSE refunded_amount END,
              updated_at = statement_timestamp()
        WHERE booking_id = $1`,
      [bookingId],
    );
    return { already: false, restocked_units: [...perRow.values()].reduce((a, b) => a + b, 0) };
  });
  return { ...result, booking: await getBooking(bookingId) };
}
