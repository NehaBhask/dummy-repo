import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Building, Castle, Check, Coffee, Home, Hotel, MapPin, Palmtree, Plane, SlidersHorizontal, ShieldCheck, Star, Store } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { useCities, useFlightRoutes, useMedia } from '../hooks.js';
import { Link, qs, useQuery, useRouter } from '../router.jsx';
import { useTrip } from '../trip.jsx';
import { addDaysISO } from '../lib/money.js';
import { Empty, ErrorBanner, Segmented, Skeleton } from '../components/ui.jsx';

const PTYPE_ICON = { hotel: Hotel, resort: Palmtree, homestay: Home, hostel: Building, apartment: Building, boutique: Store, heritage: Castle, guesthouse: Home };

export default function SearchPage() {
  const [params, setQuery] = useQuery();
  const { t } = useI18n();
  const type = params.type === 'flights' ? 'flights' : 'hotels';
  return (
    <div className="container page">
      <Link to="/" className="back-link"><ArrowLeft size={16} />{t('search.back')}</Link>
      {type === 'flights' ? <FlightResults params={params} setQuery={setQuery} /> : <HotelResults params={params} setQuery={setQuery} />}
    </div>
  );
}

function TypeSwitch({ type, setQuery }) {
  const { t } = useI18n();
  return (
    <Segmented
      value={type}
      onChange={(v) => setQuery({ type: v === 'flights' ? 'flights' : '' }, { replace: false, scroll: false })}
      label={t('home.tabs')}
      options={[{ value: 'hotels', label: t('home.hotels') }, { value: 'flights', label: t('home.flights') }]}
    />
  );
}

/* ------------------------------- hotels -------------------------------- */

function HotelResults({ params, setQuery }) {
  const { t, date } = useI18n();
  const { meta, currency } = useApp();
  const { bookable } = useCities();
  const win = meta.inventory_window;
  const desktop = useMedia('(min-width: 901px)');
  const q = params.q;

  const base = {
    city: params.city ?? 'Jaipur',
    check_in: params.check_in ?? meta.default_check_in,
    nights: Number(params.nights) || 2,
    rooms: Number(params.rooms) || 1,
    adults: Number(params.adults) || 2,
  };
  const filters = {
    max_price: params.max_price ?? '',
    min_stars: params.min_stars ?? '',
    breakfast: params.breakfast === '1',
    refundable: params.refundable === '1',
    sort: params.sort ?? 'price',
  };

  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [bounds, setBounds] = useState(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  const key = JSON.stringify([q ? { q } : { ...base, ...filters }, currency, nonce]);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    const timer = setTimeout(async () => {
      try {
        const data = q
          ? await api.aiSearch(q, currency)
          : await api.searchHotels({ ...base, ...filters, currency });
        if (mine === seq.current) setState({ status: 'done', data, error: null });
      } catch (error) {
        if (mine === seq.current) setState({ status: 'error', data: null, error });
      }
    }, q ? 0 : 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const { data, status, error } = state;
  const ai = q ? data : null;

  // What the results actually reflect (for an AI search, what the model understood).
  const eff = q && ai?.search_params
    ? {
        city: ai.search_params.city ?? base.city,
        check_in: ai.search_params.check_in ?? base.check_in,
        nights: ai.search_params.nights ?? base.nights,
        rooms: ai.search_params.rooms ?? base.rooms,
        adults: ai.search_params.adults ?? base.adults,
        max_price: ai.search_params.max_price ?? '',
        min_stars: ai.search_params.min_stars ?? '',
        breakfast: Boolean(ai.search_params.breakfast),
        refundable: Boolean(ai.search_params.refundable),
        sort: 'price',
      }
    : { ...base, ...filters };

  // Price slider bounds come from the unfiltered result set, so narrowing the cap doesn't shrink the slider.
  useEffect(() => {
    if (!data?.results) return;
    if (eff.max_price && bounds) return; // keep the bounds while the user narrows the cap
    const prices = data.results.map((r) => Number(r.from_price.amount));
    const cap = Number(eff.max_price) || 0;
    if (!prices.length && !cap) return;
    setBounds({
      lo: prices.length && !cap ? Math.floor(Math.min(...prices) / 100) * 100 : 0,
      hi: Math.ceil((Math.max(...prices, cap) * 1.15) / 100) * 100,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const serialise = (f) => ({
    city: f.city, check_in: f.check_in, nights: f.nights, rooms: f.rooms, adults: f.adults,
    max_price: f.max_price, min_stars: f.min_stars, breakfast: f.breakfast ? '1' : '', refundable: f.refundable ? '1' : '', sort: f.sort === 'price' ? '' : f.sort,
  });
  // Editing any filter turns an AI search into a normal one that starts from what the AI understood.
  const update = (patch) => setQuery({ q: '', ...serialise(eff), ...patch }, { replace: !q, scroll: false });

  const total = data?.total ?? 0;
  const out = addDaysISO(eff.check_in, eff.nights);
  const cities = bookable.length ? bookable : [{ name: eff.city }];

  return (
    <>
      <div className="results-head">
        <div>
          <p className="eyebrow">
            {date(eff.check_in, { day: 'numeric', month: 'short' })} – {date(out, { day: 'numeric', month: 'short' })} · {t('search.guests', { n: eff.adults })}
          </p>
          <h1>{t('search.headline', { city: eff.city })}</h1>
          <p className="muted">{status === 'loading' && !data ? t('common.loading') : t(total === 1 ? 'search.count1' : 'search.count', { n: total })}</p>
        </div>
        <TypeSwitch type="hotels" setQuery={setQuery} />
      </div>

      {q && ai && <AiSummary ai={ai} onPickCity={(city) => update({ city })} />}
      <ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} />

      <div className="results-layout">
        <aside className="filters-panel">
          <details key={desktop ? 'd' : 'm'} open={desktop}>
          <summary><h2><SlidersHorizontal size={16} />{t('search.filters')}</h2></summary>
          <div className="filters-body">

          <div className="filter-group">
            <label className="field-label">{t('search.city')}</label>
            <select className="input" value={eff.city} onChange={(e) => update({ city: e.target.value })}>
              {cities.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <div className="mini-grid">
              <label>
                <span className="field-label">{t('search.checkIn')}</span>
                <input className="input" type="date" value={eff.check_in} min={win.from} max={win.to} onChange={(e) => update({ check_in: e.target.value })} />
              </label>
              <label>
                <span className="field-label">{t('search.nights')}</span>
                <input className="input" type="number" min="1" max="14" value={eff.nights} onChange={(e) => update({ nights: e.target.value })} />
              </label>
              <label>
                <span className="field-label">{t('search.rooms')}</span>
                <input className="input" type="number" min="1" max="5" value={eff.rooms} onChange={(e) => update({ rooms: e.target.value })} />
              </label>
              <label>
                <span className="field-label">{t('search.adults')}</span>
                <input className="input" type="number" min="1" max="10" value={eff.adults} onChange={(e) => update({ adults: e.target.value })} />
              </label>
            </div>
          </div>

          {bounds && (
            <div className="filter-group">
              <label className="field-label" htmlFor="price-range">{t('search.pricePerNight')}</label>
              <input
                id="price-range"
                className="range"
                type="range"
                min={bounds.lo}
                max={bounds.hi}
                step={Math.max(1, Math.round((bounds.hi - bounds.lo) / 60))}
                value={eff.max_price || bounds.hi}
                onChange={(e) => update({ max_price: Number(e.target.value) >= bounds.hi ? '' : e.target.value })}
              />
              <div className="range-legend">
                <span>{new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(bounds.lo)}</span>
                <strong>{eff.max_price ? t('search.upTo', { amt: new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(eff.max_price) }) : t('search.noCap')}</strong>
                <span>{new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(bounds.hi)}+</span>
              </div>
            </div>
          )}

          <div className="filter-group">
            <p className="field-label">{t('search.rating')}</p>
            <div className="pill-row">
              {[3, 4, 5].map((n) => (
                <button key={n} type="button" className={`pill ${Number(eff.min_stars) === n ? 'on' : ''}`} onClick={() => update({ min_stars: Number(eff.min_stars) === n ? '' : n })}>
                  {n}<Star size={12} fill="currentColor" />
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <p className="field-label">{t('search.amenities')}</p>
            <div className="pill-row">
              <button type="button" className={`pill ${eff.breakfast ? 'on' : ''}`} onClick={() => update({ breakfast: eff.breakfast ? '' : '1' })}>
                {eff.breakfast && <Check size={14} />}{t('search.breakfast')}
              </button>
              <button type="button" className={`pill ${eff.refundable ? 'on' : ''}`} onClick={() => update({ refundable: eff.refundable ? '' : '1' })}>
                {eff.refundable && <Check size={14} />}{t('search.freeCancel')}
              </button>
            </div>
          </div>

          <div className="filter-group">
            <label className="field-label" htmlFor="sort">{t('search.sort')}</label>
            <select id="sort" className="input" value={eff.sort} onChange={(e) => update({ sort: e.target.value === 'price' ? '' : e.target.value })}>
              <option value="price">{t('search.sortPrice')}</option>
              <option value="rating">{t('search.sortRating')}</option>
              <option value="score">{t('search.sortScore')}</option>
            </select>
          </div>
          </div>
          </details>
        </aside>

        <section className={`results-list ${status === 'loading' && data ? 'dim-load' : ''}`} aria-live="polite">
          {status === 'loading' && !data && (
            <>
              <Skeleton h={190} />
              <Skeleton h={190} />
            </>
          )}
          {data && total === 0 && !ai?.no_results_reason && !ai?.needs_clarification && <Empty icon={MapPin} title={t('search.noneTitle')}>{t('search.noneBody')}</Empty>}
          {data?.results?.map((card) => (
            <HotelCard key={card.hotel.hotel_id} card={card} to={`/hotel/${card.hotel.hotel_id}?${qs({ city: eff.city, check_in: eff.check_in, nights: eff.nights, rooms: eff.rooms, adults: eff.adults })}`} />
          ))}
        </section>
      </div>
    </>
  );
}

function HotelCard({ card, to }) {
  const { t } = useI18n();
  const { hotel, rooms } = card;
  const Icon = PTYPE_ICON[hotel.property_type] ?? Hotel;
  const scarcest = Math.min(...rooms.map((r) => r.available_units));
  const breakfast = rooms.some((r) => r.options.some((o) => o.rate_plan?.includes_breakfast));
  const freeCancel = rooms.some((r) => r.options.some((o) => o.rate_plan?.cancellation_penalty_pct === 0));
  return (
    <article className="result-card">
      <div className="result-icon" aria-hidden="true"><Icon size={48} /></div>
      <div className="result-body">
        <div className="result-title">
          <h2>{hotel.name}</h2>
          {scarcest <= 2 && <span className="badge warn">{t('search.onlyLeft', { n: scarcest })}</span>}
        </div>
        <p className="muted small"><MapPin size={13} /> {hotel.address_line} · {hotel.distance_to_centre_km} {t('search.kmCentre')}</p>
        <p className="rating-line">
          <Star size={15} fill="currentColor" />
          <strong>{hotel.guest_score ?? '—'}</strong>
          <span className="muted">({hotel.review_count})</span>
          <span className="stars-inline">{'★'.repeat(hotel.star_rating)}</span>
        </p>
        <div className="tag-row">
          <span className="tag">{t(`ptype.${hotel.property_type}`)}</span>
          {breakfast && <span className="tag"><Coffee size={12} /> {t('search.breakfast')}</span>}
          {freeCancel && <span className="tag"><ShieldCheck size={12} /> {t('search.freeCancel')}</span>}
        </div>
      </div>
      <div className="result-price">
        <div>
          <span className="muted small">{t('search.from')}</span>
          <strong>{card.from_price.display}</strong>
          <span className="muted small">/{t('search.night')}</span>
        </div>
        <Link className="btn primary" to={to}>{t('search.viewStay')}</Link>
      </div>
    </article>
  );
}

function AiSummary({ ai, onPickCity }) {
  const { t, money } = useI18n();
  const p = ai.parsed_params ?? {};
  const sp = ai.search_params ?? {};
  const chips = [
    p.city && `📍 ${p.city}`,
    sp.check_in && `📅 ${sp.check_in} · ${sp.nights ?? 1}${t('search.nightsShort')}`,
    (sp.rooms || sp.adults) && `🛏 ${sp.rooms ?? 1} · 👤 ${sp.adults ?? 2}`,
    p.max_price_per_night && `≤ ${money(p.max_price_per_night, sp.budget_currency ?? p.currency ?? 'INR')}`,
    p.star_rating && `${p.star_rating}★+`,
    ...(p.preferences ?? []).map((x) => t(`pref.${x}`)),
  ].filter(Boolean);

  return (
    <div className="ai-card">
      <div className="ai-head">
        <span className="badge accent">{t('search.aiUnderstood')}</span>
        <span className={`badge ${ai.parser === 'gemini' ? 'good' : ai.parser === 'cache' ? 'info' : 'warn'}`}>
          {ai.parser === 'gemini' ? t('search.parserGemini') : ai.parser === 'cache' ? t('search.parserCache') : t('search.parserFallback')}
        </span>
      </div>
      {ai.parser === 'heuristic' && <p className="small muted">{t('home.aiFallbackNote')}</p>}
      {ai.needs_clarification ? (
        <p>{t('search.needCity')}</p>
      ) : (
        <div className="chips">{chips.map((c) => <span key={c} className="chip neutral">{c}</span>)}</div>
      )}
      {ai.summary && <p className="ai-summary">{ai.summary}</p>}
      {ai.no_results_reason === 'city_has_no_inventory' && (
        <div className="banner warn">
          <p>{t('search.noInventory', { city: p.city })}</p>
          <div className="chips">
            {ai.cities_with_inventory.map((c) => <button key={c} className="chip-btn" onClick={() => onPickCity(c)}>{c}</button>)}
          </div>
        </div>
      )}
      {ai.no_results_reason === 'no_match_for_filters' && <p className="hint">{t('search.noMatch')}</p>}
    </div>
  );
}

/* ------------------------------- flights ------------------------------- */

const pickDate = (dates, want, today) => {
  if (!dates?.length) return '';
  if (want) return dates.includes(want) ? want : (dates.filter((d) => d <= want).at(-1) ?? dates[0]);
  return dates.find((d) => d >= today) ?? dates[0];
};

function FlightResults({ params, setQuery }) {
  const { t, date, time } = useI18n();
  const { meta, currency, toast } = useApp();
  const { navigate } = useRouter();
  const trip = useTrip();
  const { bookable } = useCities();

  const destination = params.destination ?? 'Jaipur';
  const seats = Math.max(1, Number(params.seats) || 1);
  const routes = useFlightRoutes(destination);
  const origin = params.origin && routes?.some((r) => r.origin === params.origin) ? params.origin : (routes?.[0]?.origin ?? '');
  const route = routes?.find((r) => r.origin === origin);
  const day = pickDate(route?.dates, params.date, meta.today);

  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  useEffect(() => {
    if (!origin || !day) {
      setState({ status: routes ? 'done' : 'loading', data: null, error: null });
      return undefined;
    }
    let live = true;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    api.searchFlights({ origin, destination, date: day, seats, currency })
      .then((data) => live && setState({ status: 'done', data, error: null }))
      .catch((error) => live && setState({ status: 'error', data: null, error }));
    return () => { live = false; };
  }, [origin, destination, day, seats, currency, routes]);

  // Nothing is held here: the seat joins the trip, and one Reserve on the trip page holds everything together.
  function addToTrip(r) {
    const dup = trip.items.some((i) => i.kind === 'flight' && i.stay?.entity_id === r.stay.entity_id && i.stay?.for_date === r.stay.for_date);
    if (dup) {
      toast(t('trip.alreadyAdded'), 'info');
    } else {
      const released = trip.addItem({
        kind: 'flight',
        title: `${r.flight.airline} ${r.flight.flight_number} · ${r.flight.origin.city} → ${r.flight.destination.city}`,
        subtitle: `${date(day)} · ${t(`cabin.${r.fare.cabin_class}`)} · ${r.stay.units} ${t('trip.seats')}`,
        units: r.stay.units,
        city: r.flight.destination.city,
        stay: r.stay,
        inventoryIds: [r.inventory_id],
        total: r.price,
      });
      toast(released ? t('trip.reservationReset') : t('trip.flightAdded'), released ? 'info' : 'good');
    }
    navigate('/hold');
  }

  const { status, data, error } = state;
  const cities = bookable.length ? bookable : [{ name: destination }];
  const results = data?.results ?? [];

  return (
    <>
      <div className="results-head">
        <div>
          <p className="eyebrow">{day ? date(day, { day: 'numeric', month: 'short' }) : '—'} · {t('search.travellers', { n: seats })}</p>
          <h1>{t('search.flightsHeadline', { city: destination })}</h1>
          <p className="muted">{status === 'loading' ? t('common.loading') : t(results.length === 1 ? 'search.flightCount1' : 'search.flightCount', { n: results.length })}</p>
        </div>
        <TypeSwitch type="flights" setQuery={setQuery} />
      </div>

      <div className="flight-filters">
        <label>
          <span className="field-label">{t('trip.flyTo')}</span>
          <select className="input" value={destination} onChange={(e) => setQuery({ destination: e.target.value, origin: '', date: '' })}>
            {cities.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">{t('trip.flyFrom')}</span>
          <select className="input" value={origin} disabled={!routes?.length} onChange={(e) => setQuery({ origin: e.target.value, date: '' })}>
            {(routes ?? []).map((r) => <option key={r.origin} value={r.origin}>{r.origin}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">{t('trip.flyDate')}</span>
          <select className="input" value={day} disabled={!route} onChange={(e) => setQuery({ date: e.target.value })}>
            {(route?.dates ?? []).map((d) => <option key={d} value={d}>{date(d)}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">{t('trip.seatsLabel')}</span>
          <input className="input" type="number" min="1" max="6" value={seats} onChange={(e) => setQuery({ seats: e.target.value })} />
        </label>
      </div>

      <ErrorBanner error={error} />
      {routes?.length === 0 && <Empty icon={Plane} title={t('trip.noRoutes', { city: destination })} />}
      {status === 'loading' && !data && <Skeleton h={130} />}
      {data && results.length === 0 && routes?.length > 0 && <Empty icon={Plane} title={t('trip.noFlights')} />}

      <section className="results-list flights">
        {results.map((r) => (
          <article key={r.fare.fare_id} className="flight-card">
            <div className="result-icon small" aria-hidden="true"><Plane size={28} /></div>
            <div className="flight-main">
              <p><strong>{r.flight.airline}</strong> <span className="muted">{r.flight.flight_number}</span></p>
              <p className="flight-route">{r.flight.origin.iata}<span className="arrow">→</span>{r.flight.destination.iata}</p>
              <p className="muted small">
                {time(r.flight.departs_at)} – {time(r.flight.arrives_at)} · {Math.floor(r.flight.duration_minutes / 60)}h {r.flight.duration_minutes % 60}m · {r.flight.stops === 0 ? t('trip.nonstop') : t('trip.stops', { n: r.flight.stops })}
              </p>
              <p className="muted small">
                {t(`cabin.${r.fare.cabin_class}`)} · {r.fare.fare_class} · {r.fare.baggage_kg} kg{r.fare.refundable ? ` · ${t('trip.refundable')}` : ''}
              </p>
            </div>
            <div className="flight-cta">
              <span className={`badge ${r.available_seats <= 3 ? 'warn' : 'good'}`}>{t('trip.seatsLeft', { n: r.available_seats })}</span>
              <strong className="price">{r.price.display}</strong>
              <button className="btn primary" onClick={() => addToTrip(r)}>{t('trip.addToTrip')}</button>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
