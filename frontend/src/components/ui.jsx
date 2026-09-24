import { useEffect, useRef, useState } from 'react';
import { Inbox, Loader2, X } from 'lucide-react';
import { useI18n } from '../i18n.jsx';

export const secondsLeft = (iso) => Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
export const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export function useSecondsLeft(expiresAt) {
  const [left, setLeft] = useState(() => (expiresAt ? secondsLeft(expiresAt) : 0));
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => setLeft(secondsLeft(expiresAt));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

export function Countdown({ expiresAt, compact = false }) {
  const { t } = useI18n();
  const left = useSecondsLeft(expiresAt);
  const level = left === 0 ? 'dead' : left <= 30 ? 'urgent' : left <= 120 ? 'warn' : 'ok';
  return (
    <span className={`countdown ${level} ${compact ? 'compact' : ''}`} role="timer" aria-label={t('trip.timeLeft')}>
      <span className="countdown-dot" aria-hidden="true" />
      <span className="mono">{clock(left)}</span>
    </span>
  );
}

const TONES = {
  confirmed: 'good', captured: 'good', active: 'good', completed: 'good', success: 'good',
  pending: 'info', initiated: 'info', authorised: 'info', running: 'info',
  partially_confirmed: 'warn',
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
      <Loader2 className="spin" size={18} aria-hidden="true" />
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
        <button className="btn ghost sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ icon: Icon = Inbox, title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        <Icon size={28} />
      </div>
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export const Skeleton = ({ h = 120 }) => <div className="skeleton" style={{ height: h }} />;

/** Pill switcher, e.g. Hotels | Flights. */
export function Segmented({ value, onChange, options, label, ops = false }) {
  return (
    <div className={`segmented ${ops ? 'ops' : ''}`} role="tablist" aria-label={label}>
      {options.map(({ value: v, label: text, icon: Icon, disabled }) => (
        <button key={v} role="tab" type="button" aria-selected={value === v} disabled={disabled} className={`seg-btn ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>
          {Icon && <Icon size={16} aria-hidden="true" />}
          {text}
        </button>
      ))}
    </div>
  );
}

/** Modal confirmation (replaces window.confirm): Escape and backdrop cancel, focus lands on the safe action. */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
        <button className="dialog-x" aria-label="Close" onClick={onCancel} disabled={busy}>
          <X size={18} />
        </button>
        <h2 id="dlg-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button ref={cancelRef} className="btn outline" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="spin" size={16} /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
