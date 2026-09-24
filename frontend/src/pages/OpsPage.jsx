import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Copy, Pause, Play, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { qs } from '../router.jsx';
import { ConfirmDialog, ErrorBanner, Skeleton, StatusChip } from '../components/ui.jsx';

const HOLD_STATES = ['active', 'confirmed', 'released', 'expired'];
const BOOKING_STATES = ['confirmed', 'pending', 'partially_confirmed', 'failed', 'cancelled', 'refunded'];
const INVARIANTS = ['oversold', 'negative', 'held_drift', 'booked_drift'];

/**
 * Operations dashboard: what is in the database right now — holds, bookings, inventory, the invariant checks —
 * plus who did what. Operator login only (enforced by the API too). Refreshes every 2 seconds.
 */
export default function OpsPage() {
  const { t, num } = useI18n();
  const { toast } = useApp();
  const [watch, setWatch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.opsSummary(watch || undefined));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [watch]);

  useEffect(() => {
    load();
    if (paused) return undefined;
    const id = setInterval(() => { if (!document.hidden) load(); }, 2000);
    return () => clearInterval(id);
  }, [load, paused]);

  async function reset() {
    setBusy(true);
    try {
      const r = await api.resetDemo();
      toast(t('ops.resetDone', { holds: r.released_holds, bookings: r.cancelled_bookings }), 'good');
      setAskReset(false);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="container wide page ops-page">
        <h1>{t('ops.title')}</h1>
        <ErrorBanner error={error} onRetry={load} />
        {!error && <Skeleton h={220} />}
      </div>
    );
  }

  const { invariants, holds, bookings, inventory, watched, rooms, activity } = data;
  const violations = Object.values(invariants.counts).reduce((a, n) => a + n, 0);
  const room = rooms.find((c) => c.inventory_id === watched?.inventory_id);
  const roomPath = room ? `/hotel/${room.hotel_id}?${qs({ city: room.city, check_in: room.for_date, nights: 1, rooms: 1, adults: 1 })}` : null;

  function copyLink() {
    navigator.clipboard?.writeText(`${window.location.origin}${roomPath}`).then(() => toast(t('ops.copied'), 'good')).catch(() => {});
  }

  return (
    <div className="container wide page ops-page">
      <div className="row between wrap">
        <div>
          <h1>{t('ops.title')}</h1>
          <p className="muted small">
            <span className={`live-dot ${paused ? '' : 'on'}`} /> {t('ops.sub')} · {t('ops.updated', { time: new Date(data.checked_at).toLocaleTimeString() })}
          </p>
        </div>
        <div className="row gap wrap">
          <button className="btn ops-outline sm" onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? t('ops.resume') : t('ops.pause')}
          </button>
          <button className="btn ops-outline sm" onClick={load}><RefreshCw size={14} /> {t('common.refresh')}</button>
          <button className="btn ops-outline sm" onClick={() => setAskReset(true)}><RotateCcw size={14} /> {t('ops.reset')}</button>
        </div>
      </div>
      <ErrorBanner error={error} onRetry={load} />

      <section className={`inv-hero ${violations ? 'bad' : 'ok'}`} role="status">
        <div className="inv-mark" aria-hidden="true">{violations ? <TriangleAlert size={30} /> : <CircleCheck size={30} />}</div>
        <div className="inv-text">
          <p className="ops-label">{t('ops.invariants')}</p>
          <h2>{violations ? t('ops.violations', { n: violations }) : t('ops.zero')}</h2>
          <p className="muted small">{t('ops.invariantsWhy')}</p>
        </div>
        <div className="inv-counts">
          {INVARIANTS.map((k) => (
            <div key={k} className={`ev ${invariants.counts[k] ? 'badev' : ''}`}>
              <span className="ev-num">{invariants.counts[k]}</span>
              <span>{t(`lt.inv.${k}`)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="ops-grid">
        <section className="card">
          <h3>{t('ops.holds')}</h3>
          <div className="stats tight">
            {HOLD_STATES.map((s) => (
              <Tile key={s} label={t(`status.${s}`)} value={num(holds.by_status[s] ?? 0)} sub={t('ops.lastHour', { n: holds.last_hour[s] ?? 0 })} tone={s === 'active' ? 'warn' : s === 'confirmed' ? 'good' : ''} />
            ))}
          </div>
        </section>
        <section className="card">
          <h3>{t('ops.bookings')}</h3>
          <div className="stats tight">
            {BOOKING_STATES.map((s) => (
              <Tile key={s} label={t(`status.${s}`)} value={num(bookings.by_status[s] ?? 0)} sub={t('ops.lastHour', { n: bookings.last_hour[s] ?? 0 })} tone={s === 'confirmed' ? 'good' : s === 'failed' ? 'bad' : ''} />
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <h3>{t('ops.inventory')}</h3>
        <div className="stats tight">
          <Tile label={t('ops.units.total')} value={num(inventory.total_units)} sub={t('ops.rows', { n: num(inventory.rows) })} />
          <Tile label={t('ops.units.booked')} value={num(inventory.booked_units)} tone="bad" />
          <Tile label={t('ops.units.held')} value={num(inventory.held_units)} tone="warn" />
          <Tile label={t('ops.units.free')} value={num(inventory.free_units)} tone="good" />
        </div>
      </section>

      {watched && (
        <section className="card">
          <div className="row between wrap">
            <h3>{t('ops.watch')}</h3>
            <label className="watch-pick">
              <span className="sr-only">{t('ops.watchPick')}</span>
              <select value={watched.inventory_id} onChange={(e) => setWatch(e.target.value)}>
                {rooms.map((c) => (
                  <option key={c.inventory_id} value={c.inventory_id}>
                    {c.hotel} · {c.room_type} · {c.for_date} — {t('lt.freeOf', { free: c.free_units, total: c.total_units })}
                  </option>
                ))}
                {!room && <option value={watched.inventory_id}>{watched.title}</option>}
              </select>
            </label>
          </div>
          <div className="units-viz" aria-label={t('lt.unitsViz')}>
            {Array.from({ length: watched.total_units }, (_, i) => (
              <span key={i} className={`unit ${i < watched.booked_units ? 'booked' : i < watched.booked_units + watched.held_units ? 'held' : 'free'}`} />
            ))}
            <span className="muted small">{t('lt.legend')}</span>
          </div>
          <div className="stats tight">
            <Tile label={t('ops.units.total')} value={watched.total_units} />
            <Tile label={t('ops.units.booked')} value={watched.booked_units} tone="bad" />
            <Tile label={t('ops.units.held')} value={watched.held_units} tone="warn" />
            <Tile label={t('ops.units.free')} value={watched.free_units} tone="good" />
          </div>
          {roomPath && (
            <p className="room-link small muted">
              {t('ops.roomLink')}: <code className="mono">{roomPath}</code>
              <button className="btn ops-outline sm" onClick={copyLink}><Copy size={13} /> {t('ops.copy')}</button>
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h3>{t('ops.activity')}</h3>
        <p className="muted small">{t('ops.activityNote')}</p>
        {activity.length === 0 ? (
          <p className="muted">{t('ops.noActivity')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>{t('ops.when')}</th><th>{t('ops.who')}</th><th>{t('ops.kind')}</th><th>{t('ops.what')}</th><th>{t('bookings.status')}</th></tr>
              </thead>
              <tbody>
                {activity.map((e, i) => (
                  <tr key={`${e.kind}-${e.id ?? i}-${e.at}`} className={e.kind === 'rejected' ? 'reject-row' : ''}>
                    <td className="mono">{new Date(e.at).toLocaleTimeString()}</td>
                    <td><strong>{e.user.display_name}</strong></td>
                    <td>{t(`ops.kind.${e.kind}`)}</td>
                    <td>{e.what}{e.units ? ` × ${e.units}` : ''}{e.amount ? ` · ${e.amount} ${e.currency}` : ''}</td>
                    <td><StatusChip status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={askReset}
        title={t('ops.resetTitle')}
        confirmLabel={t('ops.resetConfirm')}
        cancelLabel={t('bookings.keep')}
        danger
        busy={busy}
        onCancel={() => setAskReset(false)}
        onConfirm={reset}
      >
        {t('ops.resetBody')}
      </ConfirmDialog>
    </div>
  );
}

const Tile = ({ label, value, sub, tone = '' }) => (
  <div className={`stat ${tone}`}>
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
    {sub && <span className="stat-sub">{sub}</span>}
  </div>
);
