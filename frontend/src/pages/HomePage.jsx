import { useEffect, useMemo, useState } from 'react';
import { Bed, Building2, CalendarDays, Castle, DoorOpen, Hotel, Landmark, MapPin, Mountain, Palmtree, Plane, PlaneTakeoff, Search, Sparkles, Star, Users, Waves } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { useCities, useFlightRoutes } from '../hooks.js';
import { qs, useRouter } from '../router.jsx';
import { Segmented } from '../components/ui.jsx';

const CITY_ICON = {
  Jaipur: Castle, Jaisalmer: Castle, Udaipur: Landmark, Agra: Landmark, Varanasi: Waves, Panaji: Palmtree, Alleppey: Palmtree,
  Kochi: Palmtree, Manali: Mountain, Shimla: Mountain, Mumbai: Building2, 'New Delhi': Building2, Kolkata: Building2, Bengaluru: Building2,
};

export default function HomePage() {
  const { t } = useI18n();
  const { meta, currency } = useApp();
  const { navigate } = useRouter();
  const { bookable } = useCities();

  const [tab, setTab] = useState('hotels');
  const [ai, setAi] = useState(false); // "Ask AI": swaps the manual bar for a natural-language one (hotels only)
  const [hotel, setHotel] = useState({ city: 'Jaipur', check_in: meta.default_check_in, nights: 2, rooms: 1, adults: 2 });
  const [flight, setFlight] = useState({ destination: 'Jaipur', origin: '', date: '', seats: 1 });
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState(false);
  const win = meta.inventory_window;

  const routes = useFlightRoutes(tab === 'flights' ? flight.destination : null);
  const route = routes?.find((r) => r.origin === flight.origin);
  // Keep the current date if the route flies that day, otherwise the first upcoming departure.
  const pickDate = (r, current) => (r.dates.includes(current) ? current : (r.dates.find((d) => d >= meta.today) ?? r.dates[0]));
  useEffect(() => {
    if (!routes?.length) return;
    setFlight((f) => {
      const r = routes.find((x) => x.origin === f.origin) ?? routes[0];
      return { ...f, origin: r.origin, date: pickDate(r, f.date) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, meta.today]);
  // Changing the origin must re-pick a date too, or the empty date locks the search button.
  const changeOrigin = (origin) => {
    const r = routes?.find((x) => x.origin === origin);
    setFlight((f) => ({ ...f, origin, date: r ? pickDate(r, f.date) : '' }));
  };

  // Flights: is there actually something to book on this route, date and party size?
  // 'idle' | 'checking' | 'ok' | 'none'. The search button stays disabled and says so when there is not.
  const [avail, setAvail] = useState('idle');
  useEffect(() => {
    if (tab !== 'flights') return undefined;
    if (routes && !routes.length) { setAvail('none'); return undefined; }
    if (!flight.origin || !flight.date) { setAvail('idle'); return undefined; }
    let live = true;
    setAvail('checking');
    api.searchFlights({ origin: flight.origin, destination: flight.destination, date: flight.date, seats: flight.seats, currency })
      .then((r) => live && setAvail(r.results.length || r.connections?.length ? 'ok' : 'none'))
      .catch(() => live && setAvail('ok')); // a failed check must not block the search; the results page reports errors
    return () => { live = false; };
  }, [tab, routes, flight.origin, flight.destination, flight.date, flight.seats, currency]);

  const setH = (k) => (e) => setHotel((h) => ({ ...h, [k]: e.target.value }));
  const setF = (k) => (e) => setFlight((f) => ({ ...f, [k]: e.target.value }));
  const noFlights = tab === 'flights' && avail === 'none';
  const noFlightsMsg = routes && !routes.length
    ? t('trip.noRoutes', { city: flight.destination })
    : t('home.noFlightsRoute', { from: flight.origin, to: flight.destination });

  function submit(e) {
    e.preventDefault();
    if (tab === 'hotels') navigate(`/search?${qs(hotel)}`);
    else if (!noFlights) navigate(`/search?${qs({ type: 'flights', ...flight })}`);
  }
  function askAI(e) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 3) return setHint(true);
    navigate(`/search?${qs({ q, type: tab === 'flights' ? 'flights' : '' })}`);
  }
  const switchTab = (v) => { setTab(v); setHint(false); };

  const cityOptions = bookable.length ? bookable : [{ name: hotel.city }];

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-blob a" aria-hidden="true" />
        <div className="hero-blob b" aria-hidden="true" />
        <div className="hero-inner">
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1 className="hero-title">{t('home.title')}</h1>
          <div className="hero-tabs">
            <Segmented
              value={tab}
              onChange={switchTab}
              label={t('home.tabs')}
              options={[{ value: 'hotels', label: t('home.hotels'), icon: Hotel }, { value: 'flights', label: t('home.flights'), icon: Plane }]}
            />
          </div>

          {ai ? (
            <>
              <form className="search-panel ai-mode" onSubmit={askAI}>
                <div className="ai-field">
                  <Sparkles size={20} className="ai-icon" aria-hidden="true" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setHint(false); }}
                    placeholder={t(tab === 'flights' ? 'home.aiPlaceholderFlights' : 'home.aiPlaceholder')}
                    aria-label={t('search.aiLabel')}
                  />
                  <button type="button" className="ai-toggle on" onClick={() => setAi(false)} aria-pressed="true">
                    <Sparkles size={14} aria-hidden="true" />{t('home.manualToggle')}
                  </button>
                </div>
                <button className="search-go" type="submit" aria-label={t('search.aiButton')}>
                  <Search size={24} />
                </button>
              </form>
              {hint && <p className="hint center">{t(tab === 'flights' ? 'home.aiHintFlights' : 'home.aiHint')}</p>}
              {!meta.ai_search.enabled && <p className="hint center">{t('search.aiOffline')}</p>}
            </>
          ) : (
            <>
              <form className={`search-panel ${tab === 'hotels' ? 'hotel-mode' : ''}`} onSubmit={submit}>
                {tab === 'hotels' ? (
                  <>
                    <div className="cell-wrap wide">
                      <label className="search-cell">
                        <MapPin size={20} aria-hidden="true" />
                        <span>
                          <span className="cell-label">{t('home.where')}</span>
                          <select value={hotel.city} onChange={setH('city')}>
                            {cityOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        </span>
                      </label>
                      <button type="button" className="ai-toggle" onClick={() => setAi(true)} aria-pressed="false" title={t('home.aiToggleHint')}>
                        <Sparkles size={14} aria-hidden="true" />{t('home.aiToggle')}
                      </button>
                    </div>
                    <label className="search-cell">
                      <CalendarDays size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('search.checkIn')}</span>
                        <input type="date" value={hotel.check_in} min={win.from} max={win.to} onChange={setH('check_in')} required />
                      </span>
                    </label>
                    <label className="search-cell narrow">
                      <Bed size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('search.nights')}</span>
                        <input type="number" min="1" max="14" value={hotel.nights} onChange={setH('nights')} />
                      </span>
                    </label>
                    <label className="search-cell narrow">
                      <DoorOpen size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('search.rooms')}</span>
                        <input type="number" min="1" max="5" value={hotel.rooms} onChange={setH('rooms')} />
                      </span>
                    </label>
                    <label className="search-cell narrow solo">
                      <Users size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('search.adults')}</span>
                        <input type="number" min="1" max="10" value={hotel.adults} onChange={setH('adults')} />
                      </span>
                    </label>
                  </>
                ) : (
                  <>
                    <div className="cell-wrap">
                      <label className="search-cell">
                        <MapPin size={20} aria-hidden="true" />
                        <span>
                          <span className="cell-label">{t('trip.flyTo')}</span>
                          <select value={flight.destination} onChange={(e) => setFlight({ destination: e.target.value, origin: '', date: '', seats: flight.seats })}>
                            {cityOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        </span>
                      </label>
                      <button type="button" className="ai-toggle" onClick={() => setAi(true)} aria-pressed="false" title={t('home.aiToggleHint')}>
                        <Sparkles size={14} aria-hidden="true" />{t('home.aiToggle')}
                      </button>
                    </div>
                    <label className="search-cell">
                      <Plane size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('trip.flyFrom')}</span>
                        <select value={flight.origin} onChange={(e) => changeOrigin(e.target.value)} disabled={!routes?.length}>
                          {(routes ?? []).map((r) => <option key={r.origin} value={r.origin}>{r.origin}</option>)}
                        </select>
                      </span>
                    </label>
                    <label className="search-cell">
                      <CalendarDays size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('trip.flyDate')}</span>
                        <FlightDate route={route} value={flight.date} onChange={setF('date')} />
                      </span>
                    </label>
                    <label className="search-cell narrow">
                      <Users size={20} aria-hidden="true" />
                      <span>
                        <span className="cell-label">{t('trip.seatsLabel')}</span>
                        <input type="number" min="1" max="6" value={flight.seats} onChange={setF('seats')} />
                      </span>
                    </label>
                  </>
                )}
                <button
                  className={`search-go ${noFlights ? 'none' : ''}`}
                  type="submit"
                  aria-label={noFlights ? noFlightsMsg : t('search.button')}
                  title={noFlights ? noFlightsMsg : undefined}
                  disabled={tab === 'flights' && (noFlights || avail === 'checking' || !flight.date)}
                >
                  {noFlights ? <PlaneTakeoff size={24} /> : <Search size={24} />}
                </button>
              </form>
              {noFlights && <p className="no-flights" role="alert">{noFlightsMsg}</p>}
              {tab === 'flights' && avail === 'checking' && <p className="hint center">{t('home.checkingFlights')}</p>}
            </>
          )}
        </div>
      </section>

      <Destinations bookable={bookable} checkIn={meta.default_check_in} currency={currency} onPick={(city) => navigate(`/search?${qs({ ...hotel, city })}`)} />
    </div>
  );
}

function FlightDate({ route, value, onChange }) {
  const { date } = useI18n();
  return (
    <select value={value} onChange={onChange} disabled={!route}>
      {(route?.dates ?? []).map((d) => <option key={d} value={d}>{date(d)}</option>)}
    </select>
  );
}

// "Popular now": the best-stocked cities, each with the real cheapest stay for the default date.
function Destinations({ bookable, checkIn, currency, onPick }) {
  const { t } = useI18n();
  const top = useMemo(() => [...bookable].sort((a, b) => b.room_nights - a.room_nights).slice(0, 8), [bookable]);
  const [cards, setCards] = useState({});

  useEffect(() => {
    let live = true;
    top.forEach((c) => {
      api.searchHotels({ city: c.name, check_in: checkIn, nights: 1, sort: 'price', limit: 1, currency })
        .then((r) => live && setCards((m) => ({ ...m, [c.name]: r.results[0] ?? null })))
        .catch(() => {});
    });
    return () => { live = false; };
  }, [top, checkIn, currency]);

  if (!top.length) return null;
  return (
    <section className="destinations">
      <div className="section-head">
        <p className="eyebrow">{t('home.popular')}</p>
        <h2>{t('home.popularTitle')}</h2>
      </div>
      <div className="dest-row">
        {top.map((c) => {
          const Icon = CITY_ICON[c.name] ?? MapPin;
          const card = cards[c.name];
          return (
            <button key={c.name} className="dest-card" onClick={() => onPick(c.name)}>
              <span className="dest-icon"><Icon size={28} /></span>
              <h3>{c.name}</h3>
              <p className="muted small">{c.state ?? c.country_code}{card ? ` · ${t(`ptype.${card.hotel.property_type}`)}` : ''}</p>
              <div className="dest-foot">
                <strong>{card ? t('home.from', { price: card.from_price.display }) : '—'}</strong>
                {card?.hotel.guest_score && <span className="dest-score"><Star size={14} fill="currentColor" />{card.hotel.guest_score}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
