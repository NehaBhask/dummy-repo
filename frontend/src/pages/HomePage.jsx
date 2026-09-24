import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bed, Bot, Building2, CalendarDays, Castle, Hotel, Landmark, MapPin, Mountain, Palmtree, Plane, Search, Star, Users, Waves } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { useCities, useFlightRoutes } from '../hooks.js';
import { qs, useRouter } from '../router.jsx';
import { Segmented } from '../components/ui.jsx';

const EXAMPLES = ['search.example1', 'search.example2', 'search.example3'];
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
  const [hotel, setHotel] = useState({ city: 'Jaipur', check_in: meta.default_check_in, nights: 2, rooms: 1, adults: 2 });
  const [flight, setFlight] = useState({ destination: 'Jaipur', origin: '', date: '', seats: 1 });
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState(false);
  const win = meta.inventory_window;

  const routes = useFlightRoutes(tab === 'flights' ? flight.destination : null);
  const route = routes?.find((r) => r.origin === flight.origin);
  useEffect(() => {
    if (!routes?.length) return;
    setFlight((f) => {
      const r = routes.find((x) => x.origin === f.origin) ?? routes[0];
      const date = r.dates.includes(f.date) ? f.date : (r.dates.find((d) => d >= meta.today) ?? r.dates[0]);
      return { ...f, origin: r.origin, date };
    });
  }, [routes, meta.today]);

  const setH = (k) => (e) => setHotel((h) => ({ ...h, [k]: e.target.value }));
  const setF = (k) => (e) => setFlight((f) => ({ ...f, [k]: e.target.value }));

  function submit(e) {
    e.preventDefault();
    if (tab === 'hotels') navigate(`/search?${qs(hotel)}`);
    else navigate(`/search?${qs({ type: 'flights', ...flight })}`);
  }
  function askAI(text) {
    const q = text.trim();
    if (q.length < 3) return setHint(true);
    navigate(`/search?${qs({ q })}`);
  }

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
              onChange={setTab}
              label={t('home.tabs')}
              options={[{ value: 'hotels', label: t('home.hotels'), icon: Hotel }, { value: 'flights', label: t('home.flights'), icon: Plane }]}
            />
          </div>

          <form className="search-panel" onSubmit={submit}>
            {tab === 'hotels' ? (
              <>
                <label className="search-cell wide">
                  <MapPin size={20} aria-hidden="true" />
                  <span>
                    <span className="cell-label">{t('home.where')}</span>
                    <select value={hotel.city} onChange={setH('city')}>
                      {cityOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </span>
                </label>
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
                  <Users size={20} aria-hidden="true" />
                  <span>
                    <span className="cell-label">{t('search.adults')}</span>
                    <input type="number" min="1" max="10" value={hotel.adults} onChange={setH('adults')} />
                  </span>
                </label>
              </>
            ) : (
              <>
                <label className="search-cell">
                  <MapPin size={20} aria-hidden="true" />
                  <span>
                    <span className="cell-label">{t('trip.flyTo')}</span>
                    <select value={flight.destination} onChange={(e) => setFlight({ destination: e.target.value, origin: '', date: '', seats: flight.seats })}>
                      {cityOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </span>
                </label>
                <label className="search-cell">
                  <Plane size={20} aria-hidden="true" />
                  <span>
                    <span className="cell-label">{t('trip.flyFrom')}</span>
                    <select value={flight.origin} onChange={(e) => setFlight((f) => ({ ...f, origin: e.target.value, date: '' }))} disabled={!routes?.length}>
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
            <button className="search-go" type="submit" aria-label={t('search.button')} disabled={tab === 'flights' && !flight.date}>
              <Search size={24} />
            </button>
          </form>
          {tab === 'flights' && routes?.length === 0 && <p className="hint center">{t('trip.noRoutes', { city: flight.destination })}</p>}
          <p className="hint center">{t('search.window', { from: win.from, to: win.to })}</p>

          <div className="ai-panel">
            <form className="ai-row" onSubmit={(e) => { e.preventDefault(); askAI(query); }}>
              <Bot size={20} className="ai-icon" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHint(false); }}
                placeholder={t('home.aiPlaceholder')}
                aria-label={t('search.aiLabel')}
              />
              <span className="ai-chip">{t('home.poweredByAi')}</span>
              <button className="btn primary" type="submit">
                {t('home.searchNaturally')} <ArrowRight size={16} />
              </button>
            </form>
            {hint && <p className="ai-hint">{t('home.aiHint')}</p>}
            {!meta.ai_search.enabled && <p className="ai-hint">{t('search.aiOffline')}</p>}
          </div>
          <div className="examples">
            <span className="muted">{t('search.try')}</span>
            {EXAMPLES.map((k) => (
              <button key={k} type="button" className="chip-btn" onClick={() => { setQuery(t(k)); askAI(t(k)); }}>{t(k)}</button>
            ))}
          </div>
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
