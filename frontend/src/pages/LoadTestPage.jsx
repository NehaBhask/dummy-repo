import { useCallback, useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Histogram, TimelineChart } from '../components/Charts.jsx';
import { ErrorBanner, Spinner } from '../components/ui.jsx';

const PRESETS = [100, 200, 500, 1000];
const CHECKS = ['no_oversell', 'exactly_free_units_granted', 'no_request_granted_twice', 'counters_reconcile', 'db_check_never_fired', 'no_transport_or_server_errors'];

export default function LoadTestPage() {
  const { t, num, money } = useI18n();
  const { toast } = useApp();
  const [rows, setRows] = useState([]);
  const [target, setTarget] = useState('');
  const [cfg, setCfg] = useState({ requests: 200, dup: 1, units: 1, bypass: true });
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const loadRows = useCallback(async () => {
    try {
      const r = await api.contended();
      setRows(r.inventory);
      setTarget((cur) => (r.inventory.some((x) => x.inventory_id === cur) ? cur : r.inventory[0]?.inventory_id ?? ''));
    } catch (e) {
      setError(e);
    }
  }, []);
  const loadSide = useCallback(() => {
    api.runs().then((r) => setHistory(r.runs)).catch(() => {});
    api.invariants().then(setInv).catch(() => {});
  }, []);

  useEffect(() => {
    loadRows();
    loadSide();
    return () => clearInterval(timer.current);
  }, [loadRows, loadSide]);

  async function fire() {
    setError(null);
    clearInterval(timer.current);
    try {
      const started = await api.startLoadTest({
        inventory_id: target || undefined,
        concurrent_requests: cfg.requests,
        duplicate_factor: cfg.dup,
        units_per_request: cfg.units,
        bypass_shield: cfg.bypass,
        mode: 'api',
      });
      setRun(started);
      timer.current = setInterval(async () => {
        try {
          const r = await api.getRun(started.run_id);
          setRun(r);
          if (r.status !== 'running') {
            clearInterval(timer.current);
            loadSide();
            loadRows();
            if (r.status === 'failed') toast(r.error ?? 'failed', 'error');
          }
        } catch {
          /* keep polling */
        }
      }, 250);
    } catch (e) {
      setError(e);
    }
  }

  const running = run?.status === 'running';
  const p = run?.progress ?? { completed: 0, success: 0, sold_out: 0, error: 0, in_flight: 0 };
  const total = run?.total_attempts ?? 0;
  const sel = rows.find((r) => r.inventory_id === target);
  const done = run?.status === 'completed';
  const stats = done ? run.summary : run?.live;
  const v = run?.verdict;
  // Once finished, count DISTINCT requests (what "granted" means). During the run only attempts are
  // known; with duplicate sends the same booking is returned to each duplicate, so attempts overcount.
  const dup = run?.config?.duplicate_factor ?? 1;
  const granted = done ? run.summary.successes : p.success;
  const soldOut = done ? run.summary.sold_out : p.sold_out;
  const errs = done ? run.summary.errors : p.error;
  const replays = done ? Math.max(0, p.success - run.summary.successes) : 0;

  return (
    <div className="container wide page loadtest">
      <h1>{t('lt.title')}</h1>
      <p className="lead">{t('lt.lead')}</p>
      <ErrorBanner error={error} />

      <section className="card lt-config">
        <div className="lt-target">
          <label>
            <span>{t('lt.target')}</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={running}>
              {rows.map((r) => (
                <option key={r.inventory_id} value={r.inventory_id}>
                  {r.hotel} · {r.room_type} · {r.for_date} — {t('lt.freeOf', { free: r.free_units, total: r.total_units })}
                </option>
              ))}
            </select>
          </label>
          {sel && (
            <div className="units-viz" aria-label={t('lt.unitsViz')}>
              {Array.from({ length: sel.total_units }, (_, i) => (
                <span key={i} className={`unit ${i < sel.booked_units ? 'booked' : i < sel.booked_units + sel.held_units ? 'held' : 'free'}`} />
              ))}
              <span className="muted small">{t('lt.legend')}</span>
            </div>
          )}
        </div>

        <div className="lt-controls">
          <div>
            <span className="label">{t('lt.requests')}</span>
            <div className="chips">
              {PRESETS.map((n) => (
                <button key={n} className={`chip-btn ${cfg.requests === n ? 'on' : ''}`} disabled={running} onClick={() => setCfg({ ...cfg, requests: n })}>
                  {num(n)}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>{t('lt.dup')}</span>
            <select value={cfg.dup} disabled={running} onChange={(e) => setCfg({ ...cfg, dup: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}×{n > 1 ? ` (${t('lt.dupNote')})` : ''}</option>)}
            </select>
          </label>
          <label>
            <span>{t('lt.units')}</span>
            <select value={cfg.units} disabled={running} onChange={(e) => setCfg({ ...cfg, units: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="check" title={t('lt.bypassHint')}>
            <input type="checkbox" checked={cfg.bypass} disabled={running} onChange={(e) => setCfg({ ...cfg, bypass: e.target.checked })} />
            <span>{t('lt.bypass')}</span>
          </label>
          <button className="btn primary fire" disabled={running || !target} onClick={fire}>
            {running ? <Spinner label={t('lt.running')} /> : <><Flame size={16} /> {t('lt.fire', { n: num(cfg.requests * cfg.dup) })}</>}
          </button>
        </div>
      </section>

      {run && (
        <>
          {done && (
            <div className={`verdict ${v.passed ? 'pass' : 'fail'}`} role="status">
              <div className="verdict-mark" aria-hidden="true">{v.passed ? '✓' : '✕'}</div>
              <div>
                <h2>{v.passed ? t('lt.verdictPass') : t('lt.verdictFail')}</h2>
                <p>{t('lt.verdictLine', { granted: run.summary.successes, expected: run.expected_successes, n: run.config.concurrent_requests, rej: run.summary.sold_out })}</p>
              </div>
            </div>
          )}

          <section className="stats">
            <Stat label={t('lt.fired')} value={num(p.completed)} sub={`/ ${num(total)}${dup > 1 ? ` ${t('lt.attemptsWord')}` : ''}`} />
            <Stat label={t('lt.inFlight')} value={num(p.in_flight)} />
            <Stat label={t('lt.granted')} value={num(granted)} tone="good" sub={`${t('lt.expected', { n: run.expected_successes })}${dup > 1 ? ` · ${done ? t('lt.distinct') : t('lt.attemptsWord')}` : ''}`} />
            <Stat label={t('lt.soldOut')} value={num(soldOut)} tone="warn" sub={dup > 1 && done ? t('lt.ofRequests', { n: run.config.concurrent_requests }) : undefined} />
            <Stat label={t('lt.errors')} value={num(errs)} tone={errs ? 'bad' : ''} />
          </section>
          {done && dup > 1 && (
            <p className="banner good small">{t('lt.dupExplain', { d: dup, n: replays })}</p>
          )}
          <div className="progress" aria-hidden="true"><div style={{ width: `${total ? (100 * p.completed) / total : 0}%` }} /></div>

          <div className="lt-grid">
            <section className="card">
              <h3>{t('lt.timeline')}</h3>
              <TimelineChart samples={run.timeline} total={total} />
              <div className="legend">
                <span className="lg completed">{t('lt.lgAnswered')}</span>
                <span className="lg soldout">{t('lt.lgSoldOut')}</span>
                <span className="lg success">{t('lt.lgGranted')}</span>
              </div>
            </section>
            <section className="card">
              <h3>{t('lt.latency')}</h3>
              <div className="pcts">
                <Pct label="p50" ms={stats?.p50_ms} />
                <Pct label="p95" ms={stats?.p95_ms} />
                <Pct label="p99" ms={stats?.p99_ms} />
              </div>
              {done && <Histogram buckets={run.histogram} />}
              {done && <p className="muted small">{t('lt.throughput', { rps: run.throughput_rps, ms: run.duration_ms })}</p>}
            </section>
          </div>

          {done && (
            <section className="card">
              <h3>{t('lt.checks')}</h3>
              <ul className="checks">
                {CHECKS.map((c) => (
                  <li key={c} className={v.checks[c] === false ? 'bad' : 'good'}>
                    <span aria-hidden="true">{v.checks[c] === null ? '–' : v.checks[c] ? '✓' : '✕'}</span>
                    <div>
                      <strong>{t(`lt.check.${c}`)}</strong>
                      <p className="muted small">{t(`lt.check.${c}.why`)}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="evidence">
                <div className="ev">
                  <span className="ev-num">{v.detail.peak_db_sessions_blocked_on_row_lock}</span>
                  <span>{t('lt.evLock')}</span>
                </div>
                <div className="ev">
                  <span className="ev-num">{v.detail.db_check_hits ?? '–'}</span>
                  <span>{t('lt.evNet')}</span>
                </div>
                <div className="ev">
                  <span className="ev-num">{v.detail.duplicate_attempts_sent}</span>
                  <span>{t('lt.evDup')}</span>
                </div>
                <div className="ev">
                  <span className="ev-num">{v.detail.invariants.global.oversold}</span>
                  <span>{t('lt.evOversold')}</span>
                </div>
              </div>
              {!run.config.bypass_shield && <p className="banner warn small">{t('lt.shieldOn')}</p>}
              {run.cleanup && <p className="muted small">{t('lt.cleanup', { n: run.cleanup.released_holds })}</p>}
            </section>
          )}
        </>
      )}

      <section className="card">
        <div className="row between wrap">
          <h3>{t('lt.invariants')}</h3>
          <button className="btn ghost small" onClick={loadSide}>{t('common.refresh')}</button>
        </div>
        {inv && (
          <div className="evidence">
            {Object.entries(inv.counts).map(([k, n]) => (
              <div className={`ev ${n ? 'badev' : ''}`} key={k}>
                <span className="ev-num">{n}</span>
                <span>{t(`lt.inv.${k}`)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="card">
          <h3>{t('lt.history')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('lt.h.when')}</th>
                  <th className="num">{t('lt.h.req')}</th>
                  <th className="num">{t('lt.h.granted')}</th>
                  <th className="num">{t('lt.h.soldOut')}</th>
                  <th className="num">p50</th>
                  <th className="num">p99</th>
                  <th>{t('lt.h.result')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.run_id}>
                    <td>{new Date(h.created_at).toLocaleTimeString()}</td>
                    <td className="num">{h.concurrent_requests}{h.duplicate_factor > 1 ? ` ×${h.duplicate_factor}` : ''}</td>
                    <td className="num">{h.successes}/{h.expected_successes}</td>
                    <td className="num">{h.sold_out}</td>
                    <td className="num">{h.p50_ms ? Math.round(h.p50_ms) : '–'}</td>
                    <td className="num">{h.p99_ms ? Math.round(h.p99_ms) : '–'}</td>
                    <td>{h.status === 'running' ? '…' : h.passed ? <span className="chip tone-good">{t('lt.pass')}</span> : <span className="chip tone-bad">{t('lt.fail')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

const Stat = ({ label, value, sub, tone = '' }) => (
  <div className={`stat ${tone}`}>
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
    {sub && <span className="stat-sub">{sub}</span>}
  </div>
);

const Pct = ({ label, ms }) => (
  <div className="pct">
    <span className="pct-label">{label}</span>
    <span className="pct-value">{ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`}</span>
  </div>
);
