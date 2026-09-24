import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useSession } from './session.jsx';

// App-wide state: server-provided config for the signed-in user, chosen currency and toasts. Routing lives in
// router.jsx, identity in session.jsx.
const AppCtx = createContext(null);

const CURRENCY_KEY = 'kognivera.currency';
const readCurrency = () => {
  try {
    return sessionStorage.getItem(CURRENCY_KEY);
  } catch {
    return null;
  }
};

export function AppProvider({ children }) {
  const { session, signOut } = useSession();
  const userId = session?.user_id ?? null;
  const [meta, setMeta] = useState(null);
  const [currencies, setCurrencies] = useState([]);
  const [bootError, setBootError] = useState(null);
  const [currency, setCurrencyState] = useState(readCurrency);
  const [toasts, setToasts] = useState([]);

  // Everything is per user: on sign-in/out the config is reloaded and a manual currency choice is dropped,
  // so each user starts in their own home currency.
  useEffect(() => {
    setMeta(null);
    setBootError(null);
    setCurrencyState(null);
    try {
      sessionStorage.removeItem(CURRENCY_KEY);
    } catch {
      /* ignore */
    }
    if (!userId) return undefined;
    let live = true;
    Promise.all([api.meta(), api.currencies()])
      .then(([m, c]) => {
        if (!live) return;
        setMeta(m);
        setCurrencies(c.currencies);
      })
      .catch((e) => {
        if (!live) return;
        if (e.code === 'invalid_session') signOut(); // the stored user no longer exists: back to the login screen
        else setBootError(e);
      });
    return () => {
      live = false;
    };
  }, [userId, signOut]);

  const setCurrency = useCallback((c) => {
    setCurrencyState(c);
    try {
      sessionStorage.setItem(CURRENCY_KEY, c);
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
      currency: currency ?? session?.home_currency ?? meta?.user?.home_currency ?? 'INR',
      setCurrency,
      toast,
      toasts,
      dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    }),
    [meta, currencies, bootError, currency, session?.home_currency, setCurrency, toast, toasts],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);
