import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import BookingTable from '../components/BookingTable.jsx';
import { Empty, ErrorBanner, Skeleton, StatusChip } from '../components/ui.jsx';

const FILTERS = ['', 'confirmed', 'cancelled', 'failed', 'pending'];

export default function BookingsPage() {
  const { t } = useI18n();
  const { navigate } = useApp();
  const [status, setStatus] = useState('');
  const [state, setState] = useState({ loading: true, bookings: [], error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await api.bookings(status);
      setState({ loading: false, bookings: r.bookings, error: null });
    } catch (error) {
      setState({ loading: false, bookings: [], error });
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page">
      <div className="row between wrap">
        <h1>{t('bookings.title')}</h1>
        <div className="chips" role="group" aria-label={t('bookings.filter')}>
          {FILTERS.map((f) => (
            <button key={f || 'all'} className={`chip-btn ${status === f ? 'on' : ''}`} onClick={() => setStatus(f)}>
              {f ? t(`status.${f}`) : t('bookings.all')}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={state.error} onRetry={load} />
      {state.loading && state.bookings.length === 0 && <Skeleton h={180} />}
      {!state.loading && !state.error && state.bookings.length === 0 && (
        <Empty icon="📄" title={t('bookings.emptyTitle')}>
          <button className="btn primary" onClick={() => navigate('search')}>{t('trip.emptyCta')}</button>
        </Empty>
      )}
      <div className="stack">
        {state.bookings.map((b) => (
          <BookingCard key={b.booking_id} booking={b} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function BookingCard({ booking: b, onChanged }) {
  const { t, dateTime, money } = useI18n();
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (!window.confirm(t('bookings.cancelConfirm'))) return;
    setBusy(true);
    try {
      const r = await api.cancel(b.booking_id);
      toast(t('bookings.cancelled', { n: r.restocked_units }), 'good');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card booking">
      <header className="row between wrap">
        <div>
          <h3>
            {t('bookings.ref')} <span className="mono">{b.booking_reference}</span> <StatusChip status={b.status} />
          </h3>
          <p className="muted small">
            {t('bookings.created', { at: dateTime(b.created_at) })}
            {b.cancelled_at && ` · ${t('bookings.cancelledAt', { at: dateTime(b.cancelled_at) })}`}
          </p>
        </div>
        <div className="outcome-total">
          <strong>{money(b.total_amount, b.currency)}</strong>
          <span className="muted small">{t('bookings.incTax', { tax: money(b.tax_amount, b.currency) })}</span>
        </div>
      </header>
      <BookingTable booking={b} />
      <footer className="row between wrap">
        <p className="muted small">
          {t('bookings.payment')}: {b.payment && <StatusChip status={b.payment.status} />}
          {b.payment?.failure_code && <span> · {t(`failure.${b.payment.failure_code}`)}</span>}
          {b.payment && Number(b.payment.refunded_amount) > 0 && <span> · {t('bookings.refunded', { amt: money(b.payment.refunded_amount, b.payment.currency) })}</span>}
        </p>
        {b.status === 'confirmed' && (
          <button className="btn danger ghost" disabled={busy} onClick={cancel}>
            {t('bookings.cancel')}
          </button>
        )}
      </footer>
    </article>
  );
}
