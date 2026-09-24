import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

// App-wide state: server-provided config, chosen currency and toasts. Routing lives in router.jsx.
const AppCtx = createContext(null);

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
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    Promise.all([api.meta(), api.currencies()])
      .then(([m, c]) => {
        setMeta(m);
        setCurrencies(c.currencies);
      })
      .catch((e) => setBootError(e));
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
      toast,
      toasts,
      dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    }),
    [meta, currencies, bootError, currency, setCurrency, toast, toasts],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);
