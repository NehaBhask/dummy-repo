import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

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
const KEY = 'kognivera.trip.v4';
const EMPTY = {
  items: [], // {id, kind:'hotel'|'flight', title, stay, inventoryIds, total, holds:[{hold_id,inventory_id}], expires_at, status}
  settings: { ttl: 0, simulate: '', method: 'card' }, // demo controls; ttl 0 = server default
  result: null, // outcome of the last confirm attempt
  lastRequest: null, // exact {key, body} of the last confirm, so it can be retried verbatim (idempotency demo)
};

const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    // Demo overrides (short hold time, simulated failure) are deliberately NOT restored: a leftover
    // "flight fails" must never silently break a later checkout. Payment method is a real preference.
    return raw ? { ...EMPTY, ...raw, settings: { ...EMPTY.settings, method: ['card', 'upi'].includes(raw.settings?.method) ? raw.settings.method : 'card' } } : EMPTY;
  } catch {
    return EMPTY;
  }
};

const DRAFT = { holds: [], expires_at: null, status: 'draft', soldOut: false };
const TripCtx = createContext(null);

export function TripProvider({ children }) {
  const [state, setState] = useState(load);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

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

  // Server truth: catch holds released/expired elsewhere (worker, another tab).
  useEffect(() => {
    const poll = async () => {
      for (const i of stateRef.current.items.filter((x) => x.status === 'active')) {
        try {
          const h = await api.getHold(i.holds[0].hold_id);
          if (h.status !== 'active') patchItem(i.id, { status: h.status === 'confirmed' ? 'confirmed' : 'expired' });
        } catch {
          /* transient: try again next tick */
        }
      }
    };
    const timer = setInterval(poll, 7000);
    return () => clearInterval(timer);
  }, [patchItem]);

  const releaseHolds = (items) =>
    Promise.allSettled(items.flatMap((i) => i.holds.map((h) => api.releaseHold(h.hold_id))));

  const value = useMemo(() => {
    const items = state.items;
    const active = items.filter((i) => i.status === 'active');
    return {
      ...state,
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
