import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, newKey } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { useTrip } from '../trip.jsx';
import BookingTable from '../components/BookingTable.jsx';
import { Countdown, Empty, Spinner, StatusChip } from '../components/ui.jsx';

export default function TripPage() {
  const { t } = useI18n();
  const { navigate } = useApp();
  const trip = useTrip();
  const hasItems = trip.items.length > 0;

  return (
    <div className="page">
      <h1>{t('trip.title')}</h1>
      {trip.result && <Outcome />}
      {!hasItems && !trip.result && (
        <Empty icon="🧳" title={t('trip.emptyTitle')}>
          <button className="btn primary" onClick={() => navigate('search')}>
            {t('trip.emptyCta')}
          </button>
        </Empty>
      )}
      {hasItems && (
        <div className="trip-grid">
          <div className="stack">
            {trip.items.map((i) => (
              <HeldItem key={i.id} item={i} />
            ))}
            <FlightAdder />
          </div>
          <Checkout />
        </div>
      )}
    </div>
  );
}

function HeldItem({ item }) {
  const { t, date } = useI18n();
  const trip = useTrip();
  const dead = item.status !== 'active';
  return (
    <article className={`card held ${dead ? 'dead' : ''}`}>
      <div className="held-icon" aria-hidden="true">{item.kind === 'hotel' ? '🏨' : '✈️'}</div>
      <div className="held-body">
        <h3>{item.title}</h3>
        <p className="muted small">
          {item.kind === 'hotel'
            ? `${item.city} · ${date(item.checkIn)} · ${item.nights} ${t('search.nightsShort')} · ${item.units} ${t('search.roomsShort')}${item.ratePlanName ? ` · ${item.ratePlanName}` : ''}`
            : `${item.subtitle}`}
        </p>
        <p className="price-line">
          {item.kind === 'hotel' ? (
            <>
              <strong>{item.total.display}</strong> <span className="muted small">({item.perNight.display}/{t('search.night')})</span>
            </>
          ) : (
            <strong>{item.total.display}</strong>
          )}
        </p>
      </div>
      <div className="held-side">
        {dead ? (
          <>
            <StatusChip status="expired" />
            <p className="small bad-text">{t('trip.expired')}</p>
          </>
        ) : (
          <>
            <span className="muted small">{t('trip.timeLeft')}</span>
            <Countdown expiresAt={item.expires_at} />
          </>
        )}
        <button className="btn ghost small" onClick={() => trip.removeItem(item.id)}>
          {dead ? t('common.remove') : t('trip.release')}
        </button>
      </div>
    </article>
  );
}

function Checkout() {
  const { t } = useI18n();
  const { currency, toast } = useApp();
  const trip = useTrip();
  const [busy, setBusy] = useState(false);
  const pending = useRef(null); // {sig, key}: the same payload always reuses the same idempotency key

  const live = trip.active;
  const anyDead = trip.items.some((i) => i.status !== 'active');
  const { method, simulate } = trip.settings;

  const body = useMemo(
    () => ({
      items: live.flatMap((i) => i.holds.map((h) => ({ hold_id: h.hold_id, ...(i.ratePlanId ? { rate_plan_id: i.ratePlanId } : {}) }))),
      currency,
      payment: { method },
      ...(simulate ? { simulate_failure: simulate } : {}),
    }),
    [live, currency, method, simulate],
  );

  async function confirm() {
    const sig = JSON.stringify(body);
    if (pending.current?.sig !== sig) pending.current = { sig, key: newKey('book') };
    await send({ key: pending.current.key, body });
  }

  async function send(req) {
    setBusy(true);
    if (simulate) trip.setSettings({ simulate: '' }); // a demo failure applies to one checkout, not every later one
    try {
      const { data, replayed } = await api.confirm(req);
      trip.setOutcome({ outcome: 'confirmed', booking: data.booking, replayed, retries: 0 }, req);
      trip.clearItems();
      pending.current = null;
      toast(t('trip.confirmedToast'), 'good');
    } catch (e) {
      if (e instanceof ApiError && e.body?.booking) {
        // the saga ran and rolled back: show exactly what was compensated
        trip.setOutcome({ outcome: 'failed', booking: e.body.booking, error: e.body.error, retries: 0 }, req);
        trip.clearItems();
        pending.current = null;
      } else {
        toast(e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card checkout">
      <h2>{t('trip.payTitle')}</h2>
      <p className="muted small">{t('trip.payNote', { pct: 12 })}</p>
      <label>
        <span>{t('trip.method')}</span>
        <select value={method} onChange={(e) => trip.setSettings({ method: e.target.value })}>
          {['mock', 'card', 'upi', 'netbanking', 'wallet'].map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{t('trip.currencyNote', { cur: currency })}</p>

      {anyDead && <div className="banner warn small">{t('trip.someExpired')}</div>}
      <button className="btn primary block" disabled={busy || live.length === 0 || anyDead} onClick={confirm}>
        {busy ? <Spinner /> : t('trip.confirmPay')}
      </button>

    </aside>
  );
}

function Outcome() {
  const { t, money } = useI18n();
  const { toast, navigate } = useApp();
  const trip = useTrip();
  const { outcome, booking, error } = trip.result;
  const [busy, setBusy] = useState(false);
  const ok = outcome === 'confirmed';

  async function retry() {
    if (!trip.lastRequest) return;
    setBusy(true);
    try {
      const { data, replayed } = await api.confirm(trip.lastRequest);
      trip.setOutcome({ ...trip.result, booking: data.booking, replayed, retries: (trip.result.retries ?? 0) + 1 });
      toast(replayed ? t('trip.retrySame') : t('trip.retryNew'), replayed ? 'good' : 'info');
    } catch (e) {
      if (e.body?.booking) {
        trip.setOutcome({ ...trip.result, booking: e.body.booking, error: e.body.error, retries: (trip.result.retries ?? 0) + 1, replayed: true });
        toast(t('trip.retrySame'), 'good');
      } else toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(t('bookings.cancelConfirm'))) return;
    setBusy(true);
    try {
      const r = await api.cancel(booking.booking_id);
      trip.setOutcome({ ...trip.result, booking: r.booking });
      toast(t('bookings.cancelled', { n: r.restocked_units }), 'good');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card outcome ${ok ? 'ok' : 'bad'}`} aria-live="polite">
      <header className="outcome-head">
        <div className="outcome-mark" aria-hidden="true">{ok ? '✓' : '↺'}</div>
        <div>
          <h2>{ok ? t('trip.bookedTitle') : t('trip.rolledBackTitle')}</h2>
          <p className="muted">
            {t('bookings.ref')} <span className="mono strong">{booking.booking_reference}</span> · <StatusChip status={booking.status} />
          </p>
        </div>
        <div className="outcome-total">
          <span className="muted small">{t('bookings.total')}</span>
          <strong>{money(booking.total_amount, booking.currency)}</strong>
          <span className="muted small">{t('bookings.incTax', { tax: money(booking.tax_amount, booking.currency) })}</span>
        </div>
      </header>

      {!ok && (
        <div className="banner bad">
          <strong>{error?.message}</strong>
          <p className="small">{t('trip.rolledBackBody')}</p>
        </div>
      )}
      {(trip.result.retries ?? 0) > 0 && (
        <div className="banner good small">{t('trip.retryProof', { n: trip.result.retries })}</div>
      )}

      <BookingTable booking={booking} />
      <p className="muted small">
        {t('bookings.payment')}: {booking.payment && <StatusChip status={booking.payment.status} />}
        {booking.payment?.failure_code && <span> · {t(`failure.${booking.payment.failure_code}`)}</span>}
      </p>

      <div className="row-actions">
        {trip.lastRequest && (
          <button className="btn ghost" disabled={busy} onClick={retry} title={t('trip.retryHint')}>
            ↻ {t('trip.retry')}
          </button>
        )}
        {ok && booking.status === 'confirmed' && (
          <button className="btn danger ghost" disabled={busy} onClick={cancel}>
            {t('bookings.cancel')}
          </button>
        )}
        <button className="btn ghost" onClick={() => navigate('bookings')}>
          {t('trip.viewBookings')}
        </button>
        <button className="btn primary" onClick={() => { trip.dismissResult(); navigate('search'); }}>
          {t('trip.newSearch')}
        </button>
      </div>
    </section>
  );
}

function FlightAdder() {
  const { t, date } = useI18n();
  const { currency, toast } = useApp();
  const trip = useTrip();
  const hotel = trip.items.find((i) => i.kind === 'hotel');
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState(hotel?.city ?? 'Jaipur');
  const [allCities, setAllCities] = useState([]);
  const [routes, setRoutes] = useState(null);
  const [origin, setOrigin] = useState('');
  const [day, setDay] = useState('');
  const [seats, setSeats] = useState(1);
  const [flights, setFlights] = useState(null);
  const [holding, setHolding] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (!allCities.length) api.cities().then((r) => setAllCities(r.cities)).catch(() => {});
    setRoutes(null);
    api.routes({ destination: dest }).then((r) => {
      setRoutes(r.routes);
      setOrigin(r.routes[0]?.origin ?? '');
    }).catch(() => setRoutes([]));
  }, [open, dest]);

  const route = routes?.find((r) => r.origin === origin);
  useEffect(() => {
    if (!route) return setDay('');
    // prefer the latest departure that still lands on or before the hotel check-in day
    const before = hotel ? route.dates.filter((d) => d <= hotel.checkIn) : [];
    setDay(before.at(-1) ?? route.dates[0]);
  }, [route, hotel]);

  useEffect(() => {
    if (!open || !origin || !day) return setFlights(null);
    setFlights(null);
    api.searchFlights({ origin, destination: dest, date: day, seats, currency }).then(setFlights).catch(() => setFlights({ results: [] }));
  }, [open, origin, dest, day, seats, currency]);

  async function hold(r) {
    setHolding(r.fare.fare_id);
    try {
      const { data } = await api.createHold({ items: [r.stay], key: newKey('hold'), ttl: trip.settings.ttl });
      trip.addItem({
        kind: 'flight',
        title: `${r.flight.airline} ${r.flight.flight_number} · ${r.flight.origin.city} → ${r.flight.destination.city}`,
        subtitle: `${date(day)} · ${t(`cabin.${r.fare.cabin_class}`)} · ${r.stay.units} ${t('trip.seats')}`,
        units: r.stay.units,
        holds: data.holds.map((h) => ({ hold_id: h.hold_id, inventory_id: h.inventory_id })),
        expires_at: data.expires_at,
        total: { display: r.price.display },
      });
      setOpen(false);
      toast(t('trip.flightHeld'), 'good');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setHolding(null);
    }
  }

  if (!open) {
    return (
      <button className="card add-flight" onClick={() => setOpen(true)}>
        <span aria-hidden="true">✈️</span> {t('trip.addFlight')}
        <span className="muted small">{t('trip.addFlightHint')}</span>
      </button>
    );
  }
  return (
    <section className="card flights">
      <header className="row between">
        <h3>{t('trip.addFlight')}</h3>
        <button className="btn ghost small" onClick={() => setOpen(false)}>{t('common.close')}</button>
      </header>
      <div className="filters compact">
        <label>
          <span>{t('trip.flyTo')}</span>
          <select value={dest} onChange={(e) => setDest(e.target.value)}>
            {(allCities.length ? allCities : [{ name: dest }]).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t('trip.flyFrom')}</span>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!routes?.length}>
            {(routes ?? []).map((r) => <option key={r.origin} value={r.origin}>{r.origin}</option>)}
          </select>
        </label>
        <label>
          <span>{t('trip.flyDate')}</span>
          <select value={day} onChange={(e) => setDay(e.target.value)} disabled={!route}>
            {(route?.dates ?? []).map((d) => <option key={d} value={d}>{date(d)}</option>)}
          </select>
        </label>
        <label>
          <span>{t('trip.seatsLabel')}</span>
          <input type="number" min="1" max="6" value={seats} onChange={(e) => setSeats(Number(e.target.value) || 1)} />
        </label>
      </div>
      {routes === null && <Spinner label={t('common.loading')} />}
      {routes?.length === 0 && <p className="hint">{t('trip.noRoutes', { city: dest })}</p>}
      {flights && flights.results.length === 0 && routes?.length > 0 && <p className="hint">{t('trip.noFlights')}</p>}
      <div className="stack tight">
        {(flights?.results ?? []).map((r) => (
          <div key={r.fare.fare_id} className="flight-row">
            <div>
              <strong>{r.flight.airline} {r.flight.flight_number}</strong>
              <p className="muted small">
                {r.flight.origin.iata} → {r.flight.destination.iata} · {Math.floor(r.flight.duration_minutes / 60)}h {r.flight.duration_minutes % 60}m · {r.flight.stops === 0 ? t('trip.nonstop') : t('trip.stops', { n: r.flight.stops })}
              </p>
              <p className="muted small">
                {t(`cabin.${r.fare.cabin_class}`)} · {r.fare.fare_class} · {r.fare.baggage_kg} kg {r.fare.refundable ? `· ${t('trip.refundable')}` : ''}
              </p>
            </div>
            <div className="flight-cta">
              <span className={`badge ${r.available_seats <= 3 ? 'bad' : 'good'}`}>{t('trip.seatsLeft', { n: r.available_seats })}</span>
              <strong>{r.price.display}</strong>
              <button className="btn primary small" disabled={holding === r.fare.fare_id} onClick={() => hold(r)}>{t('trip.holdSeat')}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
