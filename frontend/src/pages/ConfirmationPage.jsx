import { useEffect, useState } from 'react';
import { BedDouble, CalendarDays, Check, Plane, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Link, useRouter } from '../router.jsx';
import { useTrip } from '../trip.jsx';
import { addDaysISO } from '../lib/money.js';
import { groupItems, splitTitle } from '../lib/itinerary.js';
import { ConfirmDialog, ErrorBanner, Skeleton, StatusChip } from '../components/ui.jsx';
import BookingTable from '../components/BookingTable.jsx';

export default function ConfirmationPage({ bookingId }) {
  const { t, money, date } = useI18n();
  const { toast } = useApp();
  const { navigate } = useRouter();
  const trip = useTrip();
  const mine = trip.result?.booking?.booking_id === bookingId ? trip.result : null;

  const [booking, setBooking] = useState(mine?.booking ?? null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);

  useEffect(() => {
    if (mine?.booking) return setBooking(mine.booking);
    let live = true;
    api.booking(bookingId).then((b) => live && setBooking(b)).catch((e) => live && setError(e));
    return () => { live = false; };
  }, [bookingId, mine?.booking]);

  if (error) return <div className="container page narrow"><ErrorBanner error={error} /></div>;
  if (!booking) return <div className="container page narrow"><Skeleton h={360} /></div>;

  const status = booking.status;
  const ok = status === 'confirmed';
  const rolledBack = status === 'failed';
  const lines = groupItems(booking.items);
  const canRetry = Boolean(mine && trip.lastRequest);
  const retries = mine?.retries ?? 0;

  async function retry() {
    setBusy(true);
    try {
      const { data, replayed } = await api.confirm(trip.lastRequest);
      trip.setOutcome({ ...trip.result, booking: data.booking, replayed, retries: retries + 1 });
      toast(replayed ? t('trip.retrySame') : t('trip.retryNew'), replayed ? 'good' : 'info');
    } catch (e) {
      if (e.body?.booking) {
        trip.setOutcome({ ...trip.result, booking: e.body.booking, error: e.body.error, retries: retries + 1, replayed: true });
        toast(t('trip.retrySame'), 'good');
      } else toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      const r = await api.cancel(booking.booking_id);
      setBooking(r.booking);
      if (mine) trip.setOutcome({ ...trip.result, booking: r.booking });
      toast(t('bookings.cancelled', { n: r.restocked_units }), 'good');
      setAskCancel(false);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const tone = ok ? 'success' : rolledBack ? 'warn' : status === 'cancelled' ? 'muted' : 'info';
  const Mark = ok ? Check : rolledBack ? RotateCcw : status === 'cancelled' ? Undo2 : TriangleAlert;
  const title = ok ? t('confirm.title') : rolledBack ? t('trip.rolledBackTitle') : status === 'cancelled' ? t('confirm.cancelledTitle') : t('confirm.partialTitle');
  const eyebrow = ok ? t('confirm.eyebrow') : rolledBack ? t('confirm.eyebrowRolled') : t('bookings.status');

  return (
    <div className="container page narrow center-page">
      <div className={`check-badge ${tone} ${ok ? 'pop' : ''}`} aria-hidden="true"><Mark size={40} strokeWidth={3} /></div>
      <p className={`eyebrow ${tone}`}>{eyebrow}</p>
      <h1 className="confirm-title">{title}</h1>
      <p className="muted">{ok ? t('confirm.sub') : rolledBack ? t('trip.rolledBackBody') : ''}</p>

      {rolledBack && (mine?.error?.message || booking.failure?.message) && (
        <div className="banner bad left"><strong>{mine?.error?.message ?? booking.failure?.message}</strong></div>
      )}
      {retries > 0 && <div className="banner good small">{t('trip.retryProof', { n: retries })}</div>}

      <div className="confirm-card">
        <div className="confirm-head">
          <div>
            <p className="tiny muted upper">{t('confirm.reference')}</p>
            <p className="ref">{booking.booking_reference}</p>
          </div>
          <StatusChip status={status} />
        </div>

        <ul className="itinerary">
          {lines.map((l) => {
            const { room, hotel, plan } = splitTitle(l.title);
            const Icon = l.kind === 'hotel' ? BedDouble : Plane;
            return (
              <li key={l.key} className={l.status === 'compensated' ? 'struck' : ''}>
                <span className="held-icon"><Icon size={20} /></span>
                <div>
                  <h2>{hotel}</h2>
                  <p className="muted small">{[room, plan].filter(Boolean).join(' · ')}</p>
                  {l.from && (
                    <p className="muted small"><CalendarDays size={13} /> {l.kind === 'hotel'
                      ? `${date(l.from)} → ${date(addDaysISO(l.from, l.nights))} · ${l.nights === 1 ? t('hotel.oneNight') : t('hotel.nightsN', { n: l.nights })}`
                      : date(l.from)}</p>
                  )}
                </div>
                <div className="itin-right">
                  <strong>{money(l.total, l.currency)}</strong>
                  {l.status !== booking.status && <StatusChip status={l.status} />}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="confirm-total">
          <span>{ok ? t('confirm.totalPaid') : t('bookings.total')}</span>
          <strong>{money(booking.total_amount, booking.currency)}</strong>
        </div>
        <p className="muted small">{t('bookings.incTax', { tax: money(booking.tax_amount, booking.currency) })}</p>
        <p className="muted small">
          {t('bookings.payment')}: {booking.payment && <StatusChip status={booking.payment.status} />}
          {booking.payment?.failure_code && <span> · {t(`failure.${booking.payment.failure_code}`)}</span>}
        </p>
      </div>

      {(rolledBack || retries > 0) && (
        <details className="lines-detail" open={rolledBack}>
          <summary>{t('confirm.lineDetail')}</summary>
          <BookingTable booking={booking} />
        </details>
      )}

      <div className="row-actions center">
        <Link className="btn primary lg" to="/bookings">{t('trip.viewBookings')}</Link>
        {canRetry && (
          <button className="btn outline" disabled={busy} onClick={retry} title={t('trip.retryHint')}>
            <RotateCcw size={15} /> {t('trip.retry')}
          </button>
        )}
        {ok && <button className="btn ghost danger-text" disabled={busy} onClick={() => setAskCancel(true)}>{t('bookings.cancel')}</button>}
        <button className="btn ghost" onClick={() => { trip.dismissResult(); navigate('/'); }}>{t('trip.newSearch')}</button>
      </div>

      <ConfirmDialog
        open={askCancel}
        title={t('bookings.cancelTitle')}
        confirmLabel={t('bookings.cancelConfirmBtn')}
        cancelLabel={t('bookings.keep')}
        danger
        busy={busy}
        onCancel={() => setAskCancel(false)}
        onConfirm={cancel}
      >
        {t('bookings.cancelBody', { amt: money(booking.total_amount, booking.currency) })}
      </ConfirmDialog>
    </div>
  );
}
