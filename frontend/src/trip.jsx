import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

/*
 * The traveller's trip-in-progress: the holds they are keeping alive, plus the outcome of the last
 * confirmation. Persisted to localStorage so a refresh doesn't lose a running hold countdown; the
 * server remains the source of truth for whether a hold is still active (polled below).
 */
const KEY = 'kognivera.trip.v2';
const EMPTY = {
  items: [], // {id, kind:'hotel'|'flight', title, subtitle, holds:[{hold_id,inventory_id}], expires_at, status, ...}
  settings: { ttl: 0, simulate: '', method: 'mock' }, // demo controls; ttl 0 = server default
  result: null, // outcome of the last confirm attempt
  lastRequest: null, // exact {key, body} of the last confirm, so it can be retried verbatim (idempotency demo)
};

const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    // Demo overrides (short hold time, simulated failure) are deliberately NOT restored: a leftover
    // "flight fails" must never silently break a later checkout. Payment method is a real preference.
    return raw ? { ...EMPTY, ...raw, settings: { ...EMPTY.settings, method: raw.settings?.method ?? 'mock' } } : EMPTY;
  } catch {
    return EMPTY;
  }
};

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

  // Local countdown: an active hold past its deadline is dead even before the server sweeps it.
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

  const value = useMemo(
    () => ({
      ...state,
      active: state.items.filter((i) => i.status === 'active'),
      addItem: (item) =>
        setState((s) => ({
          ...s,
          result: null,
          items: [...s.items, { ...item, id: crypto.randomUUID(), status: 'active' }],
        })),
      removeItem: async (id) => {
        const item = stateRef.current.items.find((i) => i.id === id);
        setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }));
        if (item?.status === 'active') {
          // give the units back now rather than making other travellers wait for the TTL
          await Promise.allSettled(item.holds.map((h) => api.releaseHold(h.hold_id)));
        }
      },
      clearItems: () => setState((s) => ({ ...s, items: [] })),
      setSettings: (patch) => setState((s) => ({ ...s, settings: { ...s.settings, ...patch } })),
      setOutcome: (result, lastRequest) => setState((s) => ({ ...s, result, lastRequest: lastRequest ?? s.lastRequest })),
      dismissResult: () => setState((s) => ({ ...s, result: null })),
    }),
    [state],
  );
  return <TripCtx.Provider value={value}>{children}</TripCtx.Provider>;
}

export const useTrip = () => useContext(TripCtx);
