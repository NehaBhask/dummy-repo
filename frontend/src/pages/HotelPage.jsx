import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BedDouble, Building, Castle, Coffee, Home, Hotel, MapPin, Palmtree, ShieldCheck, Star, Store, Zap } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Link, qs, useQuery, useRouter } from '../router.jsx';
import { useTrip } from '../trip.jsx';
import { breakdown, TAX_PCT } from '../lib/money.js';
import { Empty, ErrorBanner, Skeleton } from '../components/ui.jsx';

const PTYPE_ICON = { hotel: Hotel, resort: Palmtree, homestay: Home, hostel: Building, apartment: Building, boutique: Store, heritage: Castle, guesthouse: Home };

export default function HotelPage({ hotelId }) {
  const { t, money } = useI18n();
  const { meta, currency, toast } = useApp();
  const { navigate } = useRouter();
  const trip = useTrip();
  const [params] = useQuery();

  const search = {
    city: params.city ?? 'Jaipur',
    check_in: params.check_in ?? meta.default_check_in,
    nights: Number(params.nights) || 2,
    rooms: Number(params.rooms) || 1,
    adults: Number(params.adults) || 2,
  };
  const backTo = `/search?${qs(search)}`;

  const [state, setState] = useState({ status: 'loading', card: null, error: null });
  const [sel, setSel] = useState({ room: 0, opt: 0 });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    // There is no single-hotel endpoint: re-run the same availability search and pick this hotel out of it.
    api.searchHotels({ ...search, currency, limit: 50 })
      .then((r) => {
        if (!live) return;
        const card = r.results.find((c) => c.hotel.hotel_id === hotelId) ?? null;
        setState({ status: 'done', card, error: null });
        setSel({ room: Math.max(0, card?.rooms.findIndex((x) => x.available_units > 0) ?? 0), opt: 0 });
      })
      .catch((error) => live && setState({ status: 'error', card: null, error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotelId, search.city, search.check_in, search.nights, search.rooms, search.adults, currency, nonce]);

  const { card, status, error } = state;
  const room = card?.rooms[sel.room];
  const opt = room?.options[Math.min(sel.opt, (room?.options.length ?? 1) - 1)];
  const price = useMemo(() => (opt ? breakdown([{ amount: opt.total.amount, currency: opt.total.currency }]) : null), [opt]);

  // Nothing is held here: the item joins the trip, and one Reserve on the trip page holds everything together.
  function addToTrip() {
    const dup = trip.items.some((i) => i.kind === 'hotel' && i.stay?.entity_id === room.stay.entity_id && i.stay?.for_date === room.stay.for_date);
    if (dup) {
      toast(t('trip.alreadyAdded'), 'info');
    } else {
      const released = trip.addItem({
        kind: 'hotel',
        title: `${room.name} @ ${card.hotel.name}`,
        city: card.hotel.city,
        checkIn: room.stay.for_date,
        nights: room.stay.nights,
        units: room.stay.units,
        stay: room.stay,
        inventoryIds: room.inventory.map((i) => i.inventory_id),
        ratePlanId: opt.rate_plan?.rate_plan_id ?? null,
        ratePlanName: opt.rate_plan?.name ?? null,
        perNight: opt.per_night,
        total: opt.total,
      });
      toast(released ? t('trip.reservationReset') : t('trip.added', { name: card.hotel.name }), released ? 'info' : 'good');
    }
    navigate('/hold');
  }

  if (status === 'loading' && !card) {
    return (
      <div className="container page"><Skeleton h={320} /><Skeleton h={160} /></div>
    );
  }
  if (status === 'error') {
    return <div className="container page"><ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  }
  if (!card) {
    return (
      <div className="container page narrow">
        <Empty icon={Hotel} title={t('hotel.gone')}>
          <Link className="btn primary" to={backTo}>{t('hotel.backToResults')}</Link>
        </Empty>
      </div>
    );
  }

  const { hotel } = card;
  const Icon = PTYPE_ICON[hotel.property_type] ?? Hotel;
  const breakfast = card.rooms.some((r) => r.options.some((o) => o.rate_plan?.includes_breakfast));
  const freeCancel = card.rooms.some((r) => r.options.some((o) => o.rate_plan?.cancellation_penalty_pct === 0));
  const perks = [
    breakfast && [Coffee, t('search.breakfast')],
    freeCancel && [ShieldCheck, t('search.freeCancel')],
    [Star, t('hotel.starType', { n: hotel.star_rating, type: t(`ptype.${hotel.property_type}`) })],
    [MapPin, `${hotel.distance_to_centre_km} ${t('search.kmCentre')}`],
    [Zap, t('hotel.instantHold')],
  ].filter(Boolean);
  const scarce = room && room.available_units <= 2;

  return (
    <div className="container page">
      <Link to={backTo} className="back-link"><ArrowLeft size={16} />{t('hotel.allStays', { city: hotel.city })}</Link>
      <div className="hotel-layout">
        <section>
          <div className="hotel-hero" aria-hidden="true"><Icon size={80} /></div>
          <div className="hotel-titlebar">
            <div>
              <h1>{hotel.name}</h1>
              <p className="muted"><MapPin size={15} /> {hotel.address_line}</p>
            </div>
            <p className="score-pill">
              <Star size={15} fill="currentColor" />
              <strong>{hotel.guest_score ?? '—'}</strong>
              <span className="muted">· {t('search.reviews', { n: hotel.review_count })}</span>
            </p>
          </div>
          <p className="hotel-desc">{hotel.description}</p>
          <div className="perk-grid">
            {perks.map(([PerkIcon, label]) => (
              <div key={label} className="perk"><PerkIcon size={20} /><p>{label}</p></div>
            ))}
          </div>

          <h2 className="section-h">{t('hotel.rooms')}</h2>
          <div className="room-list">
            {card.rooms.map((r, ri) => {
              const soldOut = r.available_units <= 0;
              return (
                <div key={r.room_type_id} className={`room-card ${sel.room === ri ? 'on' : ''} ${soldOut ? 'off' : ''}`}>
                  <button type="button" className="room-head" disabled={soldOut} onClick={() => setSel({ room: ri, opt: 0 })} aria-pressed={sel.room === ri}>
                    <span className="room-icon"><BedDouble size={22} /></span>
                    <span className="room-info">
                      <strong>{r.name}</strong>
                      <span className="muted small">
                        {t(`bed.${r.bed_config}`)} · {t('search.sleeps', { n: r.max_occupancy })}{r.size_sqm ? ` · ${r.size_sqm} m²` : ''}
                      </span>
                    </span>
                    <span className={`badge ${r.available_units <= 2 ? 'warn' : 'good'}`}>
                      {r.available_units <= 2 ? t('search.onlyLeft', { n: r.available_units }) : t('search.available', { n: r.available_units })}
                    </span>
                  </button>
                  {sel.room === ri && (
                    <div className="rate-options" role="radiogroup" aria-label={t('hotel.rateplan')}>
                      {r.options.map((o, oi) => (
                        <label key={o.rate_plan?.rate_plan_id ?? 'base'} className={`rate-option ${sel.opt === oi ? 'on' : ''}`}>
                          <input type="radio" name={`opt-${r.room_type_id}`} checked={sel.opt === oi} onChange={() => setSel({ room: ri, opt: oi })} />
                          <span className="rate-name">
                            {o.rate_plan ? o.rate_plan.name : t('search.roomOnly')}
                            <span className="rate-tags">
                              {o.rate_plan?.includes_breakfast && <span className="tag"><Coffee size={12} /> {t('search.breakfast')}</span>}
                              {o.rate_plan && o.rate_plan.cancellation_penalty_pct === 0 && <span className="tag"><ShieldCheck size={12} /> {t('search.freeCancel')}</span>}
                              {o.rate_plan && o.rate_plan.cancellation_penalty_pct > 0 && <span className="tag muted">{t('hotel.penalty', { pct: o.rate_plan.cancellation_penalty_pct })}</span>}
                            </span>
                          </span>
                          <span className="rate-price">{o.per_night.display}<small>/{t('search.night')}</small></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {room && opt && (
          <aside className="price-panel">
            <p className="muted small">{room.name}{opt.rate_plan ? ` · ${opt.rate_plan.name}` : ''}</p>
            <p className="price-big">{opt.per_night.display} <span className="muted small">/ {t('search.night')}</span></p>
            <div className="price-rows">
              <p><span>{opt.per_night.display} × {room.nights === 1 ? t('hotel.oneNight') : t('hotel.nightsN', { n: room.nights })}</span><span>{opt.total.display}</span></p>
              {price && <p><span>{t('hotel.taxes', { pct: TAX_PCT })}</span><span>{money(price.tax, price.currency)}</span></p>}
              {price && <p className="total"><span>{t('hotel.total')}</span><span>{money(price.total, price.currency)}</span></p>}
            </div>
            {scarce && <p className="low-stock">{t('hotel.lowStock', { n: room.available_units })}</p>}
            <button className="btn primary lg block" disabled={room.available_units <= 0} onClick={addToTrip}>
              {t('trip.addToTrip')}
            </button>
            <p className="muted tiny center">{t('hotel.notHeld')}</p>
          </aside>
        )}
      </div>
    </div>
  );
}
