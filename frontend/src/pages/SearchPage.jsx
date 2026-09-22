import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, newKey } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { useTrip } from '../trip.jsx';
import { Empty, ErrorBanner, Skeleton, Stars } from '../components/ui.jsx';

const EXAMPLES = ['search.example1', 'search.example2', 'search.example3'];

export default function SearchPage() {
  const { t, lang } = useI18n();
  const { meta, currency, navigate, toast } = useApp();
  const trip = useTrip();

  const [cities, setCities] = useState([]);
  const [form, setForm] = useState(() => ({
    city: 'Jaipur',
    check_in: meta.default_check_in,
    nights: 2,
    rooms: 1,
    adults: 2,
    max_price: '',
    min_stars: '',
    breakfast: false,
    sort: 'price',
  }));
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ status: 'idle', data: null, ai: null, error: null });
  const [holding, setHolding] = useState(null);
  const seq = useRef(0); // ignore responses from superseded searches

  useEffect(() => {
    api.cities().then((r) => setCities(r.cities)).catch(() => {});
  }, []);

  const run = useCallback(
    async (fn, ai = null) => {
      const mine = ++seq.current;
      setState((s) => ({ ...s, status: 'loading', error: null }));
      try {
        const data = await fn();
        if (mine === seq.current) setState({ status: 'done', data, ai, error: null });
        return data;
      } catch (error) {
        if (mine === seq.current) setState({ status: 'error', data: null, ai: null, error });
      }
    },
    [],
  );

  const structured = useCallback(
    (f = form) =>
      run(() =>
        api.searchHotels({
          city: f.city,
          check_in: f.check_in,
          nights: f.nights,
          rooms: f.rooms,
          adults: f.adults,
          max_price: f.max_price,
          min_stars: f.min_stars,
          breakfast: f.breakfast,
          sort: f.sort,
          currency,
        }),
      ),
    [form, currency, run],
  );

  // First visit and currency changes refresh the results, so prices are always in the chosen currency.
  useEffect(() => {
    if (state.ai) askAI(query);
    else structured();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  async function askAI(text) {
    const q = text.trim();
    if (q.length < 3) return;
    const data = await run(() => api.aiSearch(q, currency), 'pending');
    if (data) {
      setState((s) => ({ ...s, ai: data }));
      const p = data.search_params;
      if (p) {
        setForm((f) => ({
          ...f,
          city: p.city ?? f.city,
          check_in: p.check_in ?? f.check_in,
          nights: p.nights ?? f.nights,
          rooms: p.rooms ?? f.rooms,
          adults: p.adults ?? f.adults,
          max_price: p.max_price ?? '',
          min_stars: p.min_stars ?? '',
          breakfast: Boolean(p.breakfast),
        }));
      }
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const onSubmit = (e) => {
    e.preventDefault();
    setState((s) => ({ ...s, ai: null }));
    structured();
  };

  async function hold(card, room, option) {
    setHolding(room.room_type_id);
    try {
      const { data } = await api.createHold({ items: [room.stay], key: newKey('hold'), ttl: trip.settings.ttl });
      trip.addItem({
        kind: 'hotel',
        title: `${room.name} @ ${card.hotel.name}`,
        city: card.hotel.city,
        checkIn: room.stay.for_date,
        nights: room.stay.nights,
        units: room.stay.units,
        holds: data.holds.map((h) => ({ hold_id: h.hold_id, inventory_id: h.inventory_id })),
        expires_at: data.expires_at,
        ratePlanId: option.rate_plan?.rate_plan_id ?? null,
        ratePlanName: option.rate_plan?.name ?? null,
        perNight: option.per_night,
        total: option.total,
      });
      toast(t('search.held', { name: card.hotel.name }), 'good');
      navigate('trip');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
      if (e.code === 'sold_out') structured(); // show the fresh availability
    } finally {
      setHolding(null);
    }
  }

  const { status, data, ai, error } = state;
  const bookable = cities.filter((c) => c.bookable);
  const win = meta.inventory_window;

  return (
    <div className="page">
      <section className="hero">
        <h1>{t('search.title')}</h1>
        <p className="lead">{t('search.subtitle')}</p>
        <form
          className="ai-bar"
          onSubmit={(e) => {
            e.preventDefault();
            askAI(query);
          }}
        >
          <span className="ai-spark" aria-hidden="true">✦</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.aiPlaceholder')}
            aria-label={t('search.aiLabel')}
            lang={lang}
          />
          <button className="btn primary" type="submit" disabled={state.status === 'loading' && !!state.ai}>
            {t('search.aiButton')}
          </button>
        </form>
        <div className="examples">
          <span className="muted">{t('search.try')}</span>
          {EXAMPLES.map((k) => (
            <button
              key={k}
              className="chip-btn"
              onClick={() => {
                setQuery(t(k));
                askAI(t(k));
              }}
            >
              {t(k)}
            </button>
          ))}
        </div>
        {!meta.ai_search.enabled && <p className="hint">{t('search.aiOffline')}</p>}
      </section>

      <form className="filters card" onSubmit={onSubmit}>
        <label>
          <span>{t('search.city')}</span>
          <select value={form.city} onChange={set('city')}>
            {(bookable.length ? bookable : [{ name: form.city }]).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('search.checkIn')}</span>
          <input type="date" value={form.check_in} min={win.from} max={win.to} onChange={set('check_in')} required />
        </label>
        <label>
          <span>{t('search.nights')}</span>
          <input type="number" min="1" max="14" value={form.nights} onChange={set('nights')} />
        </label>
        <label>
          <span>{t('search.rooms')}</span>
          <input type="number" min="1" max="5" value={form.rooms} onChange={set('rooms')} />
        </label>
        <label>
          <span>{t('search.adults')}</span>
          <input type="number" min="1" max="10" value={form.adults} onChange={set('adults')} />
        </label>
        <label>
          <span>{t('search.maxPrice', { cur: currency })}</span>
          <input type="number" min="0" placeholder="—" value={form.max_price} onChange={set('max_price')} />
        </label>
        <label>
          <span>{t('search.minStars')}</span>
          <select value={form.min_stars} onChange={set('min_stars')}>
            <option value="">{t('search.any')}</option>
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}★+
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('search.sort')}</span>
          <select value={form.sort} onChange={set('sort')}>
            <option value="price">{t('search.sortPrice')}</option>
            <option value="rating">{t('search.sortRating')}</option>
            <option value="score">{t('search.sortScore')}</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.breakfast} onChange={set('breakfast')} />
          <span>{t('search.breakfast')}</span>
        </label>
        <button className="btn primary" type="submit">
          {t('search.button')}
        </button>
      </form>
      <p className="hint">{t('search.window', { from: win.from, to: win.to })}</p>

      {ai && ai !== 'pending' && <AiSummary ai={ai} onPickCity={(c) => { setState((s) => ({ ...s, ai: null })); const f = { ...form, city: c }; setForm(f); structured(f); }} />}

      <ErrorBanner error={error} onRetry={() => structured()} />

      {status === 'loading' && !data && (
        <div className="stack">
          <Skeleton h={220} />
          <Skeleton h={220} />
        </div>
      )}

      {data && (
        <section aria-live="polite" className={status === 'loading' ? 'dim-load' : ''}>
          <h2 className="section-title">{t('search.results', { n: data.total })}</h2>
          {data.total === 0 && !ai?.no_results_reason && <Empty title={t('search.noneTitle')}>{t('search.noneBody')}</Empty>}
          <div className="stack">
            {data.results.map((card) => (
              <HotelCard key={card.hotel.hotel_id} card={card} onHold={hold} holdingId={holding} />
            ))}
          </div>
        </section>
      )}
    </div>
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
    <div className="ai-card card">
      <div className="ai-head">
        <span className="badge accent">{t('search.aiUnderstood')}</span>
        <span className={`badge ${ai.parser === 'gemini' ? 'good' : 'warn'}`}>
          {ai.parser === 'gemini' ? t('search.parserGemini') : ai.parser === 'cache' ? t('search.parserCache') : t('search.parserFallback')}
        </span>
      </div>
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
            {ai.cities_with_inventory.map((c) => (
              <button key={c} className="chip-btn" onClick={() => onPickCity(c)}>{c}</button>
            ))}
          </div>
        </div>
      )}
      {ai.no_results_reason === 'no_match_for_filters' && <p className="hint">{t('search.noMatch')}</p>}
    </div>
  );
}

function HotelCard({ card, onHold, holdingId }) {
  const { t, money } = useI18n();
  const { hotel, rooms } = card;
  const [open, setOpen] = useState(false);
  return (
    <article className="card hotel">
      <header className="hotel-head">
        <div>
          <div className="hotel-title">
            <h3>{hotel.name}</h3>
            <Stars n={hotel.star_rating} />
          </div>
          <p className="muted small">
            {hotel.city} · {t(`ptype.${hotel.property_type}`)} · {hotel.distance_to_centre_km} {t('search.kmCentre')}
          </p>
        </div>
        <div className="hotel-score">
          {hotel.guest_score && <span className="score">{hotel.guest_score}</span>}
          <span className="muted small">{t('search.reviews', { n: hotel.review_count })}</span>
        </div>
      </header>
      <p className={`desc ${open ? 'open' : ''}`}>{hotel.description}</p>
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? t('common.less') : t('common.more')}
      </button>
      <div className="rooms">
        {rooms.map((room) => (
          <Room key={room.room_type_id} room={room} hotel={hotel} onHold={(opt) => onHold(card, room, opt)} busy={holdingId === room.room_type_id} />
        ))}
      </div>
    </article>
  );
}

function Room({ room, onHold, busy }) {
  const { t } = useI18n();
  const [sel, setSel] = useState(0);
  const opt = room.options[Math.min(sel, room.options.length - 1)];
  const scarce = room.available_units <= 2;
  return (
    <div className="room">
      <div className="room-info">
        <h4>{room.name}</h4>
        <p className="muted small">
          {t(`bed.${room.bed_config}`)} · {t('search.sleeps', { n: room.max_occupancy })}
          {room.size_sqm ? ` · ${room.size_sqm} m²` : ''}
        </p>
        <span className={`badge ${scarce ? 'bad' : 'good'}`}>
          {scarce ? t('search.onlyLeft', { n: room.available_units }) : t('search.available', { n: room.available_units })}
        </span>
      </div>
      <div className="room-options">
        {room.options.map((o, i) => (
          <label key={o.rate_plan?.rate_plan_id ?? 'base'} className={`option ${sel === i ? 'on' : ''}`}>
            <input type="radio" name={`opt-${room.room_type_id}`} checked={sel === i} onChange={() => setSel(i)} />
            <span className="option-name">
              {o.rate_plan ? o.rate_plan.name : t('search.roomOnly')}
              {o.rate_plan?.includes_breakfast && <span className="mini">🍳</span>}
              {o.rate_plan && o.rate_plan.cancellation_penalty_pct === 0 && <span className="mini" title={t('search.freeCancel')}>↺</span>}
            </span>
            <span className="option-price">
              {o.per_night.display}
              <small>/{t('search.night')}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="room-cta">
        <div className="total">
          <span className="muted small">{t('search.totalFor', { n: room.nights })}</span>
          <strong>{opt.total.display}</strong>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => onHold(opt)}>
          {busy ? t('common.wait') : t('search.hold')}
        </button>
      </div>
    </div>
  );
}
