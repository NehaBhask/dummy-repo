import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// A tiny History-API router: real URLs per page (so /hotel/…, /confirmation/… can be shared and
// refreshed) without a routing dependency. The backend serves index.html for any non-/api GET.
const RouterCtx = createContext(null);

// Old hash links (#/search, #/trip, …) from earlier builds keep working.
const LEGACY = { search: '/search', trip: '/hold', bookings: '/bookings', loadtest: '/loadtest' };
const read = () => {
  const legacy = window.location.hash.match(/^#\/?(\w+)/)?.[1];
  if (window.location.pathname === '/' && LEGACY[legacy]) {
    window.history.replaceState(null, '', LEGACY[legacy]);
  }
  return { path: window.location.pathname, search: window.location.search };
};

export function RouterProvider({ children }) {
  const [loc, setLoc] = useState(read);

  useEffect(() => {
    const onPop = () => setLoc(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to, { replace = false, scroll = true } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setLoc({ path: window.location.pathname, search: window.location.search });
    if (scroll) window.scrollTo({ top: 0 });
  }, []);

  const value = useMemo(() => ({ ...loc, navigate }), [loc, navigate]);
  return <RouterCtx.Provider value={value}>{children}</RouterCtx.Provider>;
}

export const useRouter = () => useContext(RouterCtx);

/** Query string as a stable object; `set` merges (empty/false values are dropped) and replaces the URL. */
export function useQuery() {
  const { search, path, navigate } = useRouter();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const set = useCallback(
    (patch, opts = { replace: true, scroll: false }) => {
      const next = { ...Object.fromEntries(new URLSearchParams(window.location.search)), ...patch };
      const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)).toString();
      navigate(qs ? `${path}?${qs}` : path, opts);
    },
    [navigate, path],
  );
  return [params, set];
}

/** Match "/hotel/:id" against a path; returns params or null. */
export function matchPath(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function Link({ to, children, onClick, replace, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === '_blank') return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    >
      {children}
    </a>
  );
}

export const qs = (obj) =>
  new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)).toString();
