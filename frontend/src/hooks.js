import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

let citiesCache = null;

/** All cities, with the ones that actually have rooms to book flagged (`bookable`). Cached for the session. */
export function useCities() {
  const [cities, setCities] = useState(citiesCache ?? []);
  useEffect(() => {
    if (citiesCache) return;
    api.cities().then((r) => {
      citiesCache = r.cities;
      setCities(r.cities);
    }).catch(() => {});
  }, []);
  const bookable = useMemo(() => cities.filter((c) => c.bookable), [cities]);
  return { cities, bookable };
}

/** Live-updating CSS media query match. */
export function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Flight routes into a destination: [{origin, dates[]}]. `routes` is null while loading. */
export function useFlightRoutes(destination) {
  const [routes, setRoutes] = useState(null);
  useEffect(() => {
    if (!destination) return undefined;
    let live = true;
    setRoutes(null);
    api.routes({ destination }).then((r) => live && setRoutes(r.routes)).catch(() => live && setRoutes([]));
    return () => {
      live = false;
    };
  }, [destination]);
  return routes;
}
