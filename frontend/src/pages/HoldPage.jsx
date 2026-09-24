import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, BedDouble, Check, Clock3, CreditCard, Info, Luggage, Plane, Plus, Smartphone, Trash2 } from 'lucide-react';
import { api, ApiError, newKey } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Link, qs, useRouter } from '../router.jsx';
import { useTrip } from '../trip.jsx';
import { breakdown, TAX_PCT } from '../lib/money.js';
import { Countdown, Empty, Spinner, StatusChip, clock, useSecondsLeft } from '../components/ui.jsx';

const luhn = (digits) => {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  });
  return sum % 10 === 0;
};

// Basic client-side validation. This is a mock gateway: the server only receives the method, never these fields.
function validate(method, f, today) {
  const e = {};
  if (method === 'card') {
    const digits = f.number.replace(/\s/g, '');
    if (!/^\d{13,19}$/.test(digits) || !luhn(digits)) e.number = 'pay.err.number';
    if (f.name.trim().length < 2) e.name = 'pay.err.name';
    const m = f.expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
    const [yy, mm] = [today.slice(2, 4), today.slice(5, 7)];
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || m[2] + m[1] < yy + mm) e.expiry = 'pay.err.expiry';
    if (!/^\d{3,4}$/.test(f.cvv)) e.cvv = 'pay.err.cvv';
  } else if (!/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(f.upi.trim())) {
    e.upi = 'pay.err.upi';
  }
  return e;
}

/**
 * "My trip": a cart of drafts that holds nothing, then ONE Reserve that places a single atomic hold for
 * every item — hotel and flight share one deadline, so the timer can never run out on one but not the other.
 * Pay is locked until the trip is reserved.
 */
export default function HoldPage() {
  const { t } = useI18n();
  const { meta, toast } = useApp();
  const trip = useTrip();
  const { reserved, items } = trip;
  const soonest = reserved ? items.map((i) => i.expires_at).sort()[0] : null;
  const left = useSecondsLeft(soonest);
  const [fields, setFields] = useState({ number: '', name: '', expiry: '', cvv: '', upi: '' });
  const [submitted, setSubmitted] = useState(false);
  const [reserving, setReserving] = useState(false);
  const attempt = useRef(null); // {sig, key}: a lost response is retried with the SAME key, so it replays instead of double-holding

  const ttlSeconds = trip.settings.ttl || meta.hold_ttl_seconds;
  const ttlLabel = ttlSeconds >= 60 ? t('hold.minutes', { n: Math.round(ttlSeconds / 60) }) : t('hold.seconds', { n: ttlSeconds });

  async function reserve() {
    const pending = items.filter((i) => i.status !== 'active');
    if (!pending.length) return;
    const sig = JSON.stringify(pending.map((i) => i.stay));
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey('trip') };
    setReserving(true);
    trip.flagSoldOut([]);
    try {
      // One request, one transaction: every row is locked in a fixed order and gets the same deadline, or none is held.
      const { data } = await api.createHold({ items: pending.map((i) => i.stay), key: attempt.current.key, ttl: trip.settings.ttl });
      attempt.current = null;
      // Holds come back in inventory_id order, so match them to items by inventory id (never by position).
      const byItem = Object.fromEntries(
        pending.map((i) => [i.id, data.holds.filter((h) => i.inventoryIds.includes(h.inventory_id)).map((h) => ({ hold_id: h.hold_id, inventory_id: h.inventory_id }))]),
      );
      if (Object.values(byItem).some((h) => h.length === 0)) {
        await Promise.allSettled(data.holds.map((h) => api.releaseHold(h.hold_id)));
        throw new Error(t('hold.mismatch'));
      }
      trip.applyReservation(byItem, data.expires_at);
      toast(t('hold.reservedToast'), 'good');
    } catch (e) {
      if (e instanceof ApiError && e.status !== 0) attempt.current = null; // a definite answer: next click is a fresh attempt
      if (e.code === 'sold_out') {
        const gone = pending.filter((i) => i.inventoryIds.includes(e.details?.inventory_id));
        trip.flagSoldOut(gone.map((i) => i.id));
        toast(gone.length ? t('hold.soldOutItem', { name: gone[0].title }) : e.message, 'error');
      } else {
        toast(e.message, 'error');
      }
    } finally {
      setReserving(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="container page narrow">
        <Empty icon={Luggage} title={t('trip.emptyTitle')}>
          <div className="row-actions center">
            <Link className="btn primary" to="/">{t('trip.emptyCta')}</Link>
            {trip.result?.booking && <Link className="btn outline" to={`/confirmation/${trip.result.booking.booking_id}`}>{t('hold.lastResult')}</Link>}
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="container page">
      <Link to="/" className="back-link"><ArrowLeft size={16} />{t('hold.keepBrowsing')}</Link>
      <h1 className="trip-title">{t('hold.tripTitle')}</h1>

      {reserved ? (
        <div className="hold-banner">
          <p><Clock3 size={16} /> {t('hold.heldForYou')}</p>
          <p className={`hold-time ${left < 60 ? 'pulse' : ''}`} role="timer" aria-label={t('trip.timeLeft')}>{clock(left)}</p>
          <p className="muted">{t('hold.completeBefore')}</p>
        </div>
      ) : trip.hasExpired ? (
        <div className="banner warn">
          <span><strong>{t('hold.expiredKeep')}</strong> {t('hold.expiredKeepBody')}</span>
        </div>
      ) : (
        <div className="trip-banner">
          <Info size={18} />
          <p><strong>{t('hold.notHeldBanner')}</strong> {t('hold.notHeldBody', { time: ttlLabel })}</p>
        </div>
      )}

      <div className="pay-layout">
        <section className="pay-main">
          <h2 className="section-h">{t('hold.yourItems')}</h2>
          <div className="stack">
            {items.map((i) => <TripItem key={i.id} item={i} />)}
            <AddMore items={items} />
          </div>
          <Payment fields={fields} setFields={(patch) => setFields((f) => ({ ...f, ...patch }))} submitted={submitted} />
        </section>
        <Summary fields={fields} submitted={submitted} setSubmitted={setSubmitted} reserve={reserve} reserving={reserving} ttlLabel={ttlLabel} left={left} />
      </div>
    </div>
  );
}

function TripItem({ item }) {
  const { t, date } = useI18n();
  const trip = useTrip();
  const Icon = item.kind === 'hotel' ? BedDouble : Plane;
  return (
    <article className={`held-item ${item.status === 'expired' || item.soldOut ? 'dead' : ''}`}>
      <div className="held-icon" aria-hidden="true"><Icon size={22} /></div>
      <div className="held-body">
        <h3>{item.title}</h3>
        <p className="muted small">
          {item.kind === 'hotel'
            ? `${item.city} · ${date(item.checkIn)} · ${item.nights} ${t('search.nightsShort')} · ${item.units} ${t('search.roomsShort')}${item.ratePlanName ? ` · ${item.ratePlanName}` : ''}`
            : item.subtitle}
        </p>
        <p className="price-line"><strong>{item.total.display}</strong>{item.kind === 'hotel' && <span className="muted small"> ({item.perNight.display}/{t('search.night')})</span>}</p>
        {item.soldOut && <p className="small bad-text">{t('hold.itemSoldOut')}</p>}
      </div>
      <div className="held-side">
        {item.status === 'active' ? (
          <><span className="muted tiny">{t('trip.timeLeft')}</span><Countdown expiresAt={item.expires_at} /></>
        ) : item.status === 'expired' ? (
          <StatusChip status="expired" />
        ) : (
          <span className="chip tone-muted">{t('hold.notReserved')}</span>
        )}
        <button className="btn ghost sm" onClick={() => trip.removeItem(item.id)}>
          <Trash2 size={14} /> {t('common.remove')}
        </button>
      </div>
    </article>
  );
}

// The saga needs at least two lines to be interesting: nudge the missing half of a hotel + flight trip.
function AddMore({ items }) {
  const { t } = useI18n();
  const hotel = items.find((i) => i.kind === 'hotel');
  const flight = items.find((i) => i.kind === 'flight');
  const links = [];
  if (!flight) links.push({ key: 'f', to: `/search?${qs({ type: 'flights', destination: hotel?.city, date: hotel?.checkIn })}`, title: t('trip.addFlight'), hint: t('trip.addFlightHint') });
  if (!hotel) links.push({ key: 'h', to: `/search?${qs({ city: flight?.city, check_in: flight?.stay?.for_date })}`, title: t('hold.addHotel'), hint: t('hold.addHotelHint') });
  return links.map((l) => (
    <Link key={l.key} to={l.to} className="add-flight">
      <span className="held-icon"><Plus size={20} /></span>
      <span><strong>{l.title}</strong><span className="muted small block">{l.hint}</span></span>
    </Link>
  ));
}

/* Card / UPI form. Field state lives in the page so the Pay button can validate it. */
function Payment({ fields: f, setFields: setF, submitted }) {
  const { t } = useI18n();
  const { meta } = useApp();
  const trip = useTrip();
  const { method } = trip.settings;
  const errs = submitted ? validate(method, f, meta.today) : {};

  const fmtNumber = (v) => v.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
  const fmtExpiry = (v) => {
    const d = v.replace(/\D/g, '').slice(0, 4);
    return d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
  };
  const fillDemo = () => {
    setF({ number: '4242 4242 4242 4242', name: meta.user.display_name, expiry: '12 / 30', cvv: '123', upi: 'demo@okbank' });
  };
  const Err = ({ k }) => (errs[k] ? <span className="field-err" role="alert">{t(errs[k])}</span> : null);

  return (
    <div className="pay-section">
      <div className="row between wrap">
        <h2 className="section-h">{t('hold.howToPay')}</h2>
        {meta.demo_controls && <button type="button" className="link small" onClick={fillDemo}>{t('hold.fillDemo')}</button>}
      </div>
      <div className="method-grid" role="radiogroup" aria-label={t('trip.method')}>
        {[['card', CreditCard, t('method.card')], ['upi', Smartphone, t('method.upi')]].map(([value, Icon, label]) => (
          <button key={value} type="button" role="radio" aria-checked={method === value} className={`method-btn ${method === value ? 'on' : ''}`} onClick={() => trip.setSettings({ method: value })}>
            <Icon size={20} />{label}
          </button>
        ))}
      </div>

      {method === 'card' ? (
        <div className="form-grid">
          <label className={`field ${errs.number ? 'bad' : ''}`}>
            <span>{t('pay.cardNumber')}</span>
            <input className="input lg" inputMode="numeric" autoComplete="off" placeholder="4242 4242 4242 4242" value={f.number} onChange={(e) => setF({ number: fmtNumber(e.target.value) })} />
            <Err k="number" />
          </label>
          <label className={`field ${errs.name ? 'bad' : ''}`}>
            <span>{t('pay.nameOnCard')}</span>
            <input className="input lg" autoComplete="off" placeholder={t('pay.namePlaceholder')} value={f.name} onChange={(e) => setF({ name: e.target.value })} />
            <Err k="name" />
          </label>
          <div className="two">
            <label className={`field ${errs.expiry ? 'bad' : ''}`}>
              <span>{t('pay.expiry')}</span>
              <input className="input lg" inputMode="numeric" autoComplete="off" placeholder="MM / YY" value={f.expiry} onChange={(e) => setF({ expiry: fmtExpiry(e.target.value) })} />
              <Err k="expiry" />
            </label>
            <label className={`field ${errs.cvv ? 'bad' : ''}`}>
              <span>CVV</span>
              <input className="input lg" inputMode="numeric" autoComplete="off" placeholder="•••" maxLength={4} value={f.cvv} onChange={(e) => setF({ cvv: e.target.value.replace(/\D/g, '') })} />
              <Err k="cvv" />
            </label>
          </div>
        </div>
      ) : (
        <div className="form-grid">
          <label className={`field ${errs.upi ? 'bad' : ''}`}>
            <span>{t('pay.upiId')}</span>
            <input className="input lg" autoComplete="off" placeholder="name@bank" value={f.upi} onChange={(e) => setF({ upi: e.target.value })} />
            <Err k="upi" />
          </label>
        </div>
      )}
      <p className="muted tiny">{t('hold.mockNote')}</p>
    </div>
  );
}

function Summary({ fields, submitted, setSubmitted, reserve, reserving, ttlLabel, left }) {
  const { t, money } = useI18n();
  const { currency, toast, meta } = useApp();
  const { navigate } = useRouter();
  const trip = useTrip();
  const [busy, setBusy] = useState(false);
  const pending = useRef(null); // {sig, key}: the same payload always reuses the same idempotency key
  const { items, reserved, active: live } = trip;
  const anySoldOut = items.some((i) => i.soldOut);
  const { method, simulate } = trip.settings;

  const price = useMemo(() => breakdown(items.map((i) => ({ amount: i.total.amount, currency: i.total.currency }))), [items]);

  const body = useMemo(
    () => ({
      items: live.flatMap((i) => i.holds.map((h) => ({ hold_id: h.hold_id, ...(i.ratePlanId ? { rate_plan_id: i.ratePlanId } : {}) }))),
      currency,
      payment: { method },
      ...(simulate ? { simulate_failure: simulate } : {}),
    }),
    [live, currency, method, simulate],
  );

  async function pay() {
    if (!reserved) return;
    setSubmitted(true);
    if (Object.keys(validate(method, fields, meta.today)).length) {
      toast(t('pay.fixFields'), 'error');
      return;
    }
    const sig = JSON.stringify(body);
    if (pending.current?.sig !== sig) pending.current = { sig, key: newKey('book') };
    const req = { key: pending.current.key, body };
    setBusy(true);
    if (simulate) trip.setSettings({ simulate: '' }); // a demo failure applies to one checkout, not every later one
    try {
      const { data, replayed } = await api.confirm(req);
      trip.setOutcome({ outcome: 'confirmed', booking: data.booking, replayed, retries: 0 }, req);
      trip.clearItems();
      pending.current = null;
      setSubmitted(false);
      navigate(`/confirmation/${data.booking.booking_id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body?.booking) {
        // the saga ran and rolled back: show exactly what was compensated
        trip.setOutcome({ outcome: 'failed', booking: e.body.booking, error: e.body.error, retries: 0 }, req);
        trip.clearItems();
        pending.current = null;
        navigate(`/confirmation/${e.body.booking.booking_id}`);
      } else {
        toast(e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="summary-panel">
      <h2>{t('hold.summary')}</h2>
      <ul className="summary-lines">
        {items.map((i) => (
          <li key={i.id}><span>{i.title}</span><strong>{i.total.display}</strong></li>
        ))}
      </ul>
      {price ? (
        <div className="price-rows">
          <p><span>{t('hold.subtotal')}</span><span>{money(price.subtotal, price.currency)}</span></p>
          <p><span>{t('hotel.taxes', { pct: TAX_PCT })}</span><span>{money(price.tax, price.currency)}</span></p>
          <p className="total"><span>{t('hotel.total')}</span><span className="accent">{money(price.total, price.currency)}</span></p>
        </div>
      ) : (
        <p className="muted small">{t('trip.currencyNote', { cur: currency })}</p>
      )}

      {reserved ? (
        <div className="reserved-note" role="status">
          <span><Check size={16} /> {t('hold.reserved')} · <span className="mono">{clock(left)}</span></span>
          <button type="button" className="link small" onClick={() => trip.releaseReservation()}>{t('hold.releaseAll')}</button>
        </div>
      ) : (
        <button className="btn primary lg block" disabled={reserving || anySoldOut} onClick={reserve}>
          {reserving ? <Spinner label={t('hold.reserving')} /> : t('hold.reserve', { time: ttlLabel })}
        </button>
      )}

      <button className={`btn lg block ${reserved ? 'primary' : 'outline'}`} disabled={!reserved || busy} onClick={pay}>
        {busy ? <Spinner /> : t('hold.payNow')}
      </button>
      <p className="muted tiny center">{reserved ? t('hold.secure') : t('hold.reserveFirst')}</p>
    </aside>
  );
}
