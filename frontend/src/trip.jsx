import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { useApp } from './context.jsx';
import { useI18n } from './i18n.jsx';
import { fromCents, toCents } from './lib/money.js';

/*
 * The traveller's trip. It works like a cart followed by ONE reservation:
 *
 *   draft    the item is in the trip but nothing is held — availability can still change
 *   active   Reserve placed one atomic hold for the whole trip; every item shares a single deadline
 *   expired  the shared deadline passed; the item stays in the trip and can be reserved again
 *
 * Invariant: active items always share one deadline. Changing the trip while it is reserved (adding an
 * item) therefore releases the reservation and returns everything to draft — never a mix of deadlines.
 *
 * Persisted to localStorage so a refresh doesn't lose a running countdown; the server stays the source
 * of truth for whether a hold is still active (polled below).
 */
// One stored trip per demo user, so switching user never shows someone else's cart or reservation.
const storageKey = (userId) => `kognivera.trip.v4:${userId ?? 'anon'}`;
const EMPTY = {
  items: [], // {id, kind:'hotel'|'flight', title, stay, inventoryIds, total, holds:[{hold_id,inventory_id}], expires_at, status}
  settings: { ttl: 0, simulate: '', method: 'card' }, // demo controls; ttl 0 = server default
  result: null, // outcome of the last confirm attempt
  lastRequest: null, // exact {key, body} of the last confirm, so it can be retried verbatim (idempotency demo)
};

const load = (key) => {
  try {
    const raw = JSON.parse(localStorage.getItem(key));
    // Demo overrides (short hold time, simulated failure) are deliberately NOT restored: a leftover
    // "flight fails" must never silently break a later checkout. Payment method is a real preference.
    return raw ? { ...EMPTY, ...raw, settings: { ...EMPTY.settings, method: ['card', 'upi'].includes(raw.settings?.method) ? raw.settings.method : 'card' } } : EMPTY;
  } catch {
    return EMPTY;
  }
};

const DRAFT = { holds: [], expires_at: null, status: 'draft', soldOut: false };

const DAY = 86_400_000;
const dayNumber = (iso) => Math.round(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY);

/**
 * The server's live holds -> trip items, so a reservation made anywhere (the chat assistant, another tab) shows up on the trip
 * page with its countdown and can be paid from there. A hotel stay of N nights is N holds (one per night): consecutive nights of
 * the same room that share a deadline become one item again.
 */
export function itemsFromHolds(holds, money, { date, t }) {
  const totalOf = (list) => {
    const cents = list.reduce((a, h) => a + (h.price ? toCents(h.price.amount) : 0n), 0n);
    const currency = list.find((h) => h.price)?.price.currency ?? 'INR';
    return { amount: fromCents(cents), currency, display: money(fromCents(cents), currency), cents };
  };
  const hotels = holds.filter((h) => h.inventory?.entity_type === 'room_type');
  const flights = holds.filter((h) => h.inventory?.entity_type === 'flight_fare');
  const items = [];

  const groups = new Map();
  for (const h of [...hotels].sort((a, b) => String(a.inventory.for_date).localeCompare(String(b.inventory.for_date)))) {
    const key = `${h.inventory.entity_id}|${h.expires_at}|${h.units}`;
    const runs = groups.get(key) ?? [];
    const last = runs.at(-1);
    if (last && dayNumber(h.inventory.for_date) - dayNumber(last.at(-1).inventory.for_date) === 1) last.push(h);
    else runs.push([h]);
    groups.set(key, runs);
  }
  for (const runs of groups.values()) {
    for (const run of runs) {
      const first = run[0];
      const total = totalOf(run);
      const perNight = { amount: fromCents(total.cents / BigInt(run.length)), currency: total.currency };
      items.push({
        id: `hold:${first.hold_id}`,
        kind: 'hotel',
        title: first.inventory.title,
        city: first.inventory.hotel_city,
        checkIn: String(first.inventory.for_date).slice(0, 10),
        nights: run.length,
        units: first.units,
        stay: { entity_type: 'room_type', entity_id: first.inventory.entity_id, for_date: String(first.inventory.for_date).slice(0, 10), nights: run.length, units: first.units },
        inventoryIds: run.map((h) => h.inventory_id),
        ratePlanId: null,
        ratePlanName: null,
        perNight: { ...perNight, display: money(perNight.amount, perNight.currency) },
        total: { amount: total.amount, currency: total.currency, display: total.display },
        holds: run.map((h) => ({ hold_id: h.hold_id, inventory_id: h.inventory_id })),
        expires_at: first.expires_at,
        status: 'active',
        soldOut: false,
      });
    }
  }
  for (const h of flights) {
    const total = totalOf([h]);
    const i = h.inventory;
    items.push({
      id: `hold:${h.hold_id}`,
      kind: 'flight',
      title: `Flight ${i.flight_number} · ${i.origin_iata} → ${i.dest_iata}`,
      subtitle: `${date(i.for_date)} · ${t(`cabin.${i.cabin_class}`)} · ${h.units} ${t('trip.seats')}`,
      units: h.units,
      city: i.dest_city,
      stay: { entity_type: 'flight_fare', entity_id: i.entity_id, for_date: String(i.for_date).slice(0, 10), nights: 1, units: h.units },
      inventoryIds: [h.inventory_id],
      total: { amount: total.amount, currency: total.currency, display: total.display },
      holds: [{ hold_id: h.hold_id, inventory_id: h.inventory_id }],
      expires_at: h.expires_at,
      status: 'active',
      soldOut: false,
    });
  }
  return items;
}
const TripCtx = createContext(null);

export function TripProvider({ userId, children }) {
  const key = storageKey(userId);
  const i18n = useI18n();
  const { money } = i18n;
  const { currency } = useApp();
  const [state, setState] = useState(() => load(key));
  const stateRef = useRef(state);
  stateRef.current = state;
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const currencyRef = useRef(currency);
  currencyRef.current = currency;

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, key]);

  const patchItem = useCallback((id, patch) => {
    setState((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  }, []);

  // Local countdown: a reservation past its deadline is dead even before the server sweeps it.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const late = stateRef.current.items.filter((i) => i.status === 'active' && Date.parse(i.expires_at) <= now);
      for (const i of late) patchItem(i.id, { status: 'expired' });
    }, 1000);
    return () => clearInterval(timer);
  }, [patchItem]);

  // Reservations the traveller has on the server that this cart does not know about yet (made by the chat assistant, or in
  // another tab) join the trip as active items, so they appear on the trip page with their countdown.
  const syncHolds = useCallback(async () => {
    let list;
    try {
      list = (await api.holds(currencyRef.current)).holds;
    } catch {
      return; // transient, or not signed in: try again on the next tick
    }
    const fresh = itemsFromHolds(list, i18nRef.current.money, i18nRef.current);
    setState((s) => {
      const known = new Set(s.items.flatMap((i) => i.holds.map((h) => h.hold_id)));
      const add = fresh.filter((it) => !it.holds.some((h) => known.has(h.hold_id)));
      return add.length ? { ...s, items: [...s.items, ...add] } : s;
    });
  }, []);

  // Server truth: catch holds released/expired elsewhere (worker, another tab, the assistant), and pick up new ones.
  useEffect(() => {
    const poll = async () => {
      for (const i of stateRef.current.items.filter((x) => x.status === 'active')) {
        try {
          const h = await api.getHold(i.holds[0].hold_id);
          if (h.status === 'confirmed' || h.status === 'released') {
            // paid or given back somewhere else (for example by the assistant): it is no longer part of this cart
            setState((s) => ({ ...s, items: s.items.filter((x) => x.id !== i.id) }));
          } else if (h.status !== 'active') {
            patchItem(i.id, { status: 'expired' });
          }
        } catch {
          /* transient: try again next tick */
        }
      }
      await syncHolds();
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [patchItem, syncHolds]);

  const releaseHolds = (items) =>
    Promise.allSettled(items.flatMap((i) => i.holds.map((h) => api.releaseHold(h.hold_id))));

  const value = useMemo(() => {
    const items = state.items;
    const active = items.filter((i) => i.status === 'active');
    return {
      ...state,
      syncHolds,
      active,
      reserved: items.length > 0 && active.length === items.length,
      hasExpired: items.some((i) => i.status === 'expired'),

      /** Add a draft. Returns true when an existing reservation had to be released to keep one shared deadline. */
      addItem: (item) => {
        const held = stateRef.current.items.filter((i) => i.status === 'active');
        if (held.length) releaseHolds(held); // give the units back now; the whole trip is re-reserved together
        setState((s) => ({
          ...s,
          result: null,
          items: [
            ...s.items.map((i) => (i.status === 'active' ? { ...i, ...DRAFT } : i)),
            { ...item, ...DRAFT, id: crypto.randomUUID() },
          ],
        }));
        return held.length > 0;
      },

      /** One Reserve → every item gets its holds and the same deadline. */
      applyReservation: (holdsByItem, expiresAt) =>
        setState((s) => ({
          ...s,
          items: s.items.map((i) => (holdsByItem[i.id] ? { ...i, holds: holdsByItem[i.id], expires_at: expiresAt, status: 'active', soldOut: false } : i)),
        })),
      flagSoldOut: (ids) => setState((s) => ({ ...s, items: s.items.map((i) => ({ ...i, soldOut: ids.includes(i.id) })) })),

      /** Give the whole reservation back (units return to the pool now) but keep the trip. */
      releaseReservation: async () => {
        const held = stateRef.current.items.filter((i) => i.status === 'active');
        setState((s) => ({ ...s, items: s.items.map((i) => (i.status === 'active' ? { ...i, ...DRAFT } : i)) }));
        await releaseHolds(held);
      },

      removeItem: async (id) => {
        const item = stateRef.current.items.find((i) => i.id === id);
        setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }));
        if (item?.status === 'active') await releaseHolds([item]);
      },
      clearItems: () => setState((s) => ({ ...s, items: [] })),
      setSettings: (patch) => setState((s) => ({ ...s, settings: { ...s.settings, ...patch } })),
      setOutcome: (result, lastRequest) => setState((s) => ({ ...s, result, lastRequest: lastRequest ?? s.lastRequest })),
      dismissResult: () => setState((s) => ({ ...s, result: null })),
    };
  }, [state]);
  return <TripCtx.Provider value={value}>{children}</TripCtx.Provider>;
}

export const useTrip = () => useContext(TripCtx);
