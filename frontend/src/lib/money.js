// Money is a 2-place decimal string + ISO code (R3). Arithmetic here is on integer minor units
// (BigInt) so nothing is ever a float; Number() is used only at the very end, for display.
export const TAX_PCT = 12; // mirrors backend/src/money.js TAX_RATE — the server is authoritative at confirm time

export const toCents = (amount) => {
  const s = String(amount ?? '0');
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};

export const fromCents = (c) => {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/** tax = subtotal × 12%, rounded half up to the minor unit — same rule as the server. */
export const taxOf = (cents) => (cents * BigInt(TAX_PCT) + 50n) / 100n;

/** { subtotal, tax, total } as decimal strings for lines that share one currency; null if they don't. */
export function breakdown(lines) {
  const usable = lines.filter((l) => l?.amount != null);
  if (!usable.length || usable.length !== lines.length) return null;
  const cur = usable[0].currency;
  if (usable.some((l) => l.currency !== cur)) return null;
  const sub = usable.reduce((a, l) => a + toCents(l.amount), 0n);
  const tax = taxOf(sub);
  return { currency: cur, subtotal: fromCents(sub), tax: fromCents(tax), total: fromCents(sub + tax) };
}

export const addDaysISO = (iso, n) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
};
