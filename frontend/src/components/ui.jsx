import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';

export function Countdown({ expiresAt, compact = false }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(() => Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  const level = left === 0 ? 'dead' : left <= 30 ? 'urgent' : left <= 120 ? 'warn' : 'ok';
  return (
    <span className={`countdown ${level} ${compact ? 'compact' : ''}`} role="timer" aria-label={t('trip.timeLeft')}>
      <span className="countdown-dot" aria-hidden="true" />
      <span className="mono">
        {mm}:{ss}
      </span>
    </span>
  );
}

const TONES = {
  confirmed: 'good', captured: 'good', active: 'good', completed: 'good', success: 'good',
  pending: 'warn', initiated: 'warn', authorised: 'warn', partially_confirmed: 'warn', running: 'warn',
  cancelled: 'muted', refunded: 'muted', voided: 'muted', released: 'muted', expired: 'muted',
  failed: 'bad', compensated: 'bad', sold_out: 'bad',
};

export function StatusChip({ status }) {
  const { t } = useI18n();
  return <span className={`chip tone-${TONES[status] ?? 'muted'}`}>{t(`status.${status}`)}</span>;
}

export function Stars({ n }) {
  return (
    <span className="stars" aria-label={`${n} star`}>
      {'★'.repeat(n)}
      <span className="dim">{'★'.repeat(Math.max(0, 5 - n))}</span>
    </span>
  );
}

export function Spinner({ label }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="banner bad" role="alert">
      <strong>{error.message}</strong>
      {error.code === 'network' && <span> — {t('error.network')}</span>}
      {onRetry && (
        <button className="btn ghost small" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ icon = '◌', title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export const Skeleton = ({ h = 120 }) => <div className="skeleton" style={{ height: h }} />;
