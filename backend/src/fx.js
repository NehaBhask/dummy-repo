import { pool } from './db.js';
import { AppError } from './errors.js';
import { D, money, formatMoney } from './money.js';

// fx_rates only carries INR and USD as base currencies (24 quotes each), so every conversion
// pivots through INR:  amount[X] / rate(INR→X) * rate(INR→Y).
const TTL_MS = 5 * 60_000;
let cache = null;

async function load() {
  const [rates, currencies] = await Promise.all([
    pool.query(
      `SELECT quote_currency, rate::text AS rate, rate_date::text AS rate_date
         FROM fx_rates
        WHERE base_currency = 'INR'
          AND rate_date = COALESCE(
                (SELECT max(rate_date) FROM fx_rates WHERE base_currency = 'INR' AND rate_date <= CURRENT_DATE),
                (SELECT min(rate_date) FROM fx_rates WHERE base_currency = 'INR'))`,
    ),
    pool.query('SELECT iso4217, symbol, minor_unit_exponent, display_locale, name FROM currencies'),
  ]);
  const map = { INR: D(1) };
  for (const r of rates.rows) map[r.quote_currency] = D(r.rate);
  return {
    at: Date.now(),
    rateDate: rates.rows[0]?.rate_date ?? null,
    rates: map,
    currencies: Object.fromEntries(currencies.rows.map((c) => [c.iso4217, c])),
  };
}

export async function fxContext() {
  if (!cache || Date.now() - cache.at > TTL_MS) cache = await load();
  return cache;
}

export function resetFxCache() {
  cache = null;
}

export function assertCurrency(ctx, code) {
  if (!ctx.currencies[code] || !ctx.rates[code]) {
    throw new AppError('validation_error', { details: { currency: `unsupported currency ${code}` } });
  }
}

/** Convert a decimal string between currencies; result is a 2dp decimal string (R3). */
export function convert(ctx, amount, from, to) {
  if (from === to) return money(amount);
  assertCurrency(ctx, from);
  assertCurrency(ctx, to);
  return money(D(amount).div(ctx.rates[from]).mul(ctx.rates[to]));
}

/** {amount, currency, display} pair for API responses. */
export function moneyOut(ctx, amount, currency) {
  return { amount: money(amount), currency, display: formatMoney(money(amount), ctx.currencies[currency]) };
}
