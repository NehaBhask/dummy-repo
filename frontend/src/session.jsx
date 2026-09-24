import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { setApiUser } from './api.js';

/*
 * Mock login. The session is a persona picked on the login screen, kept in sessionStorage so every browser tab
 * is its own session (Alice in one window, Bob in another; opening the site in a second browser works the same).
 * It is sent as `X-User-Id` on every request. There is no password: this is a demo identity, not authentication.
 *
 * session = { user_id, display_name, home_currency, role: 'traveller' | 'operator' }
 */
const KEY = 'kognivera.session';
const SessionCtx = createContext(null);

const read = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
};

export function SessionProvider({ children }) {
  const [session, setSession] = useState(read);
  setApiUser(session?.user_id ?? null); // synchronously, so requests made during this render already carry the user

  const signIn = useCallback((next) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode: the session still works until the tab reloads */
    }
    setSession(next);
  }, []);
  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, role: session?.role ?? null, signIn, signOut }), [session, signIn, signOut]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
