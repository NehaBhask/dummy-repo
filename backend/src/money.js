import Decimal from 'decimal.js';

// R3: money is a fixed-point decimal with exactly 2 places plus a currency code. Never a float.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const D = (v) => new Decimal(v);
export const money = (v) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
export const sum = (values) => values.reduce((acc, v) => acc.plus(v), D(0));

// Derived from the seed: for every confirmed booking, total = subtotal × 1.12 and
// tax = subtotal × 0.12 (both to 2dp).
export const TAX_RATE = D('0.12');

export function withTax(subtotal) {
  const sub = D(subtotal);
  const tax = sub.mul(TAX_RATE).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { subtotal: sub.toFixed(2), tax: tax.toFixed(2), total: sub.plus(tax).toFixed(2) };
}

/**
 * Display string only. `Number()` is acceptable here because the value is being rendered, never
 * added to anything. Fraction digits follow currencies.minor_unit_exponent (JPY 0, KWD 3, …).
 */
export function formatMoney(amount, meta) {
  if (!meta) return `${amount}`;
  try {
    return new Intl.NumberFormat(meta.display_locale, {
      style: 'currency',
      currency: meta.iso4217,
      minimumFractionDigits: meta.minor_unit_exponent,
      maximumFractionDigits: meta.minor_unit_exponent,
    }).format(Number(amount));
  } catch {
    return `${meta.symbol}${amount}`;
  }
}
