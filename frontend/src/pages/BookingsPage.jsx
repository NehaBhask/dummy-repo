import { useCallback, useEffect, useMemo, useState } from 'react';
import { BedDouble, CalendarDays, ChevronDown, Plane } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Link } from '../router.jsx';
import { addDaysISO, fromCents, toCents } from '../lib/money.js';
import { groupItems, isUpcoming, splitTitle } from '../lib/itinerary.js';
import { ConfirmDialog, Empty, ErrorBanner, Segmented, Skeleton, StatusChip } from '../components/ui.jsx';
import BookingTable from '../components/BookingTable.jsx';

export default function BookingsPage() {
  const { t } = useI18n();
  const { meta } = useApp();
  const [tab, setTab] = useState('upcoming');
  const [state, setState] = useState({ loading: true, bookings: [], error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await api.bookings();
      setState({ loading: false, bookings: r.bookings, error: null });
    } catch (error) {
      setState({ loading: false, bookings: [], error });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { upcoming, past } = useMemo(() => {
    const up = [];
    const pa = [];
    state.bookings.forEach((b) => (isUpcoming(b, meta.today) ? up : pa).push(b));
    return { upcoming: up, past: pa };
  }, [state.bookings, meta.today]);
  const shown = tab === 'upcoming' ? upcoming : past;

  return (
    <div className="container page narrow-lg">
      <p className="eyebrow">{t('bookings.eyebrow')}</p>
      <div className="row between wrap">
        <h1>{t('bookings.title')}</h1>
        <Segmented
          value={tab}
          onChange={setTab}
          label={t('bookings.title')}
          options={[
            { value: 'upcoming', label: `${t('bookings.upcoming')} (${upcoming.length})` },
            { value: 'past', label: `${t('bookings.past')} (${past.length})` },
          ]}
        />
      </div>
      <ErrorBanner error={state.error} onRetry={load} />
      {state.loading && state.bookings.length === 0 && <Skeleton h={130} />}
      {!state.loading && !state.error && shown.length === 0 && (
        <Empty icon={CalendarDays} title={t(tab === 'upcoming' ? 'bookings.emptyUpcoming' : 'bookings.emptyPast')}>
          <Link className="btn primary" to="/">{t('trip.emptyCta')}</Link>
        </Empty>
      )}
      <div className="stack">
        {shown.map((b) => <BookingCard key={b.booking_id} booking={b} onChanged={load} />)}
      </div>
    </div>
  );
}

function BookingCard({ booking: b, onChanged }) {
  const { t, money, date, dateTime } = useI18n();
  const { toast, meta } = useApp();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const [open, setOpen] = useState(false);

  const lines = groupItems(b.items);
  const first = lines[0];
  const { hotel } = splitTitle(first?.title);
  const extra = lines.length - 1;
  const Icon = first?.kind === 'flight' ? Plane : BedDouble;
  const upcoming = isUpcoming(b, meta.today);
  // Cancellation refunds what was captured (full refund — see backend "known limitations").
  const refund = b.payment ? fromCents(toCents(b.payment.captured_amount) - toCents(b.payment.refunded_amount)) : b.total_amount;

  async function cancel() {
    setBusy(true);
    try {
      const r = await api.cancel(b.booking_id);
      toast(t('bookings.cancelled', { n: r.restocked_units }), 'good');
      setAsk(false);
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="booking-card">
      <div className="booking-row">
        <div className="held-icon big" aria-hidden="true"><Icon size={24} /></div>
        <div className="booking-main">
          <div className="row wrap gap">
            <h2><Link to={`/confirmation/${b.booking_id}`}>{hotel || t('bookings.booking')}</Link></h2>
            <StatusChip status={b.status} />
          </div>
          <p className="muted small">
            {first?.from
              ? first.kind === 'hotel' ? `${date(first.from)} → ${date(addDaysISO(first.from, first.nights))}` : date(first.from)
              : dateTime(b.created_at)}
            {extra > 0 && ` · ${t('bookings.moreItems', { n: extra })}`} · {t('bookings.ref')} <span className="mono">{b.booking_reference}</span>
          </p>
          {b.cancelled_at && <p className="muted tiny">{t('bookings.cancelledAt', { at: dateTime(b.cancelled_at) })}</p>}
          {b.payment && Number(b.payment.refunded_amount) > 0 && <p className="muted tiny">{t('bookings.refunded', { amt: money(b.payment.refunded_amount, b.payment.currency) })}</p>}
        </div>
        <div className="booking-side">
          <strong>{money(b.total_amount, b.currency)}</strong>
          {upcoming && b.status === 'confirmed' && (
            <button className="btn ghost sm" disabled={busy} onClick={() => setAsk(true)}>{t('bookings.cancel')}</button>
          )}
        </div>
      </div>
      <button className="details-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t('bookings.details')} <ChevronDown size={14} className={open ? 'flip' : ''} />
      </button>
      {open && <BookingTable booking={b} />}

      <ConfirmDialog
        open={ask}
        title={t('bookings.cancelTitle')}
        confirmLabel={t('bookings.cancelConfirmBtn')}
        cancelLabel={t('bookings.keep')}
        danger
        busy={busy}
        onCancel={() => setAsk(false)}
        onConfirm={cancel}
      >
        {t('bookings.cancelBody', { amt: money(refund, b.currency) })}
      </ConfirmDialog>
    </article>
  );
}
