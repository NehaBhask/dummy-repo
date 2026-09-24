import { fromCents, toCents } from './money.js';

const STATUS_RANK = ['compensated', 'failed', 'cancelled', 'pending', 'confirmed'];

/**
 * A hotel stay is stored as one booking line per night. For display, fold consecutive nights of the
 * same room back into one line (Standard @ Hotel · 12–15 Oct · 3 nights); a flight stays one line.
 * The folded status is the "worst" of its nights so a rolled-back line is never shown as confirmed.
 */
export function groupItems(items = []) {
  const groups = new Map();
  for (const i of items) {
    const key = `${i.entity_type}:${i.entity_id}:${i.title}`;
    const g = groups.get(key) ?? { key, title: i.title, kind: i.entity_type === 'room_type' ? 'hotel' : 'flight', dates: [], units: 0, cents: 0n, currency: i.currency, statuses: new Set(), compensated_at: null };
    if (i.for_date) g.dates.push(String(i.for_date).slice(0, 10));
    g.units = Math.max(g.units, i.units);
    g.cents += toCents(i.line_total);
    g.statuses.add(i.status);
    g.compensated_at ||= i.compensated_at;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const dates = [...g.dates].sort();
    const status = STATUS_RANK.find((s) => g.statuses.has(s)) ?? 'pending';
    return { ...g, dates, from: dates[0] ?? null, nights: g.kind === 'hotel' ? dates.length : 0, total: fromCents(g.cents), status };
  });
}

/** Hotel-and-room title split for cards: "Standard @ Hotel — Rate plan" → { room, hotel, plan } */
export function splitTitle(title = '') {
  const [head, plan] = title.split(' — ');
  const [room, hotel] = head.split(' @ ');
  return { room: hotel ? room : null, hotel: hotel ?? room, plan: plan ?? null };
}

/** Booking counts as "upcoming" while it is live and its last night has not passed yet. */
export function isUpcoming(booking, today) {
  const live = ['confirmed', 'pending', 'partially_confirmed'].includes(booking.status);
  if (!live) return false;
  const dates = booking.items.map((i) => i.for_date).filter(Boolean).map((d) => String(d).slice(0, 10)).sort();
  return !dates.length || dates.at(-1) >= today;
}
