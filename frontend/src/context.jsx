import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

// App-wide state: server-provided config, chosen currency, hash routing and toasts.
const AppCtx = createContext(null);
const ROUTES = ['search', 'trip', 'bookings', 'loadtest'];
const parseHash = () => {
  const r = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.includes(r) ? r : 'search';
};

export function AppProvider({ children }) {
  const [meta, setMeta] = useState(null);
  const [currencies, setCurrencies] = useState([]);
  const [bootError, setBootError] = useState(null);
  const [currency, setCurrencyState] = useState(() => {
    try {
      return localStorage.getItem('kognivera.currency');
    } catch {
      return null;
    }
  });
  const [route, setRoute] = useState(parseHash);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    Promise.all([api.meta(), api.currencies()])
      .then(([m, c]) => {
        setMeta(m);
        setCurrencies(c.currencies);
      })
      .catch((e) => setBootError(e));
  }, []);

  const navigate = useCallback((r) => {
    window.location.hash = `/${r}`;
    window.scrollTo({ top: 0 });
  }, []);

  const setCurrency = useCallback((c) => {
    setCurrencyState(c);
    try {
      localStorage.setItem('kognivera.currency', c);
    } catch {
      /* ignore */
    }
  }, []);

  const toast = useCallback((message, kind = 'info') => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);

  const value = useMemo(
    () => ({
      meta,
      currencies,
      bootError,
      currency: currency ?? meta?.user?.home_currency ?? 'INR',
      setCurrency,
      route,
      navigate,
      toast,
      toasts,
      dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    }),
    [meta, currencies, bootError, currency, setCurrency, route, navigate, toast, toasts],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);
