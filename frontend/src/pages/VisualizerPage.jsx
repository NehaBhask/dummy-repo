import { useEffect, useMemo, useRef, useState } from 'react';
import { CreditCard, Database, LockKeyhole, Monitor, Play, RotateCcw, Server, Zap } from 'lucide-react';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { Link } from '../router.jsx';
import { Segmented } from '../components/ui.jsx';
import { DOTS, SCENARIOS, SIM_FREE, timelines } from '../viz/scenarios.js';
import { liveRuns } from '../viz/live.js';

const SIGNAL = { blue: 'info', green: 'good', red: 'bad', amber: 'warn', grey: 'idle' };
const LABEL = { race: 'viz.race', saga: 'viz.saga', retry: 'viz.retry' };

export default function VisualizerPage() {
  const { t } = useI18n();
  const { meta, currency, toast } = useApp();
  const [scenario, setScenario] = useState('race');
  const [mode, setMode] = useState('simulated'); // 'simulated' | 'live'
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);
  const [liveEvents, setLiveEvents] = useState([]);
  const target = useRef(0);
  const abort = useRef(null);
  const started = useRef(0);

  const stopLive = () => { abort.current?.abort(); abort.current = null; };
  useEffect(() => stopLive, []);

  // Switching source only resets the view; a live run (which writes real bookings) starts on an explicit click.
  function switchMode(next) {
    stopLive();
    setMode(next);
    setTick(0);
    target.current = 0;
    setLiveEvents([]);
    setRunning(next === 'simulated');
  }

  function start(next = scenario, nextMode = mode) {
    stopLive();
    setScenario(next);
    setMode(nextMode);
    setTick(0);
    target.current = 0;
    setLiveEvents([]);
    if (nextMode === 'simulated') return setRunning(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    started.current = performance.now();
    setRunning(true);
    const emit = (e) => {
      target.current = e.at;
      setLiveEvents((list) => [...list, { ...e, id: list.length, ms: performance.now() - started.current }]);
    };
    liveRuns[next]({ emit, signal: ctrl.signal, ctx: { today: meta.today, checkIn: meta.default_check_in, currency } })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        emit({ at: target.current, signal: 'red', message: t('viz.liveFailed'), payload: { error: err.message } });
        toast(err.message, 'error');
      })
      .finally(() => { if (abort.current === ctrl) { abort.current = null; target.current = 100; setRunning(false); } });
  }

  // Simulated clock: one step per 80 ms, like a recorded run.
  useEffect(() => {
    if (mode !== 'simulated' || !running) return undefined;
    const id = setInterval(() => setTick((v) => { if (v >= 100) { setRunning(false); return 100; } return v + 1; }), 80);
    return () => clearInterval(id);
  }, [mode, running]);

  // Live clock: ease toward whatever the real run has reported so far.
  useEffect(() => {
    if (mode !== 'live') return undefined;
    const id = setInterval(() => setTick((v) => {
      const diff = target.current - v;
      return Math.abs(diff) < 0.4 ? target.current : v + Math.sign(diff) * Math.min(Math.abs(diff), 1.4);
    }), 40);
    return () => clearInterval(id);
  }, [mode]);

  const events = useMemo(
    () => (mode === 'simulated' ? timelines[scenario].filter((e) => e.at <= tick).map((e, i) => ({ ...e, id: i, ms: e.at * 80 })) : liveEvents),
    [mode, scenario, tick, liveEvents],
  );
  const current = events.at(-1);
  const free0 = events.find((e) => typeof e.payload.free === 'number')?.payload.free ?? SIM_FREE;
  const remaining = [...events].reverse().find((e) => typeof e.payload.remaining === 'number')?.payload.remaining;
  const free = Math.max(0, remaining ?? free0);
  const dots = useMemo(() => Array.from({ length: DOTS[scenario] }, (_, i) => i), [scenario]);
  const live = mode === 'live';
  const busy = live && running;

  return (
    <div className="viz container wide page">
      <div className="viz-head">
        <div>
          <div className="viz-status">
            <span className={`dot ${running ? 'on' : ''}`} />
            <p className="mono">
              {live ? t('viz.sourceLive') : t('viz.sourceSim')} · {running ? t('viz.live') : t('viz.ready')}
            </p>
          </div>
          <h1>{t('viz.title')}</h1>
        </div>
        <div className="viz-controls">
          <Segmented
            ops
            value={mode}
            onChange={switchMode}
            label={t('viz.source')}
            options={[{ value: 'simulated', label: t('viz.simulated'), disabled: busy }, { value: 'live', label: t('viz.liveBackend'), disabled: busy }]}
          />
          <div className="scenario-btns">
            {SCENARIOS.map((s) => (
              <button key={s} className={`btn sm ${scenario === s ? 'primary' : 'ops-outline'}`} disabled={busy && scenario !== s} onClick={() => start(s)}>
                {scenario === s && running ? <RotateCcw size={14} /> : <Play size={14} />}
                {t(LABEL[s])}
              </button>
            ))}
          </div>
        </div>
      </div>
      {live && <p className="viz-note">{t('viz.liveNote')}</p>}

      <div className="viz-grid">
        <section className="viz-canvas-card">
          <div className="viz-canvas-top">
            <div>
              <p className="ops-label">{t('viz.active')}</p>
              <p className="viz-scenario">{t(LABEL[scenario])}</p>
            </div>
            {scenario === 'race' && (
              <div className="free-box"><p className="mono">{free}</p><p>{t('viz.free')}</p></div>
            )}
          </div>

          <div className="viz-canvas">
            <svg viewBox="0 0 900 480" className="viz-svg" aria-hidden="true">
              <path d="M145 220 C260 220 280 220 380 220 S510 220 600 220" className="path main" />
              <path d="M470 220 C560 120 620 100 730 105" className="path" />
              <path d="M470 220 C560 340 620 360 730 370" className="path" />
            </svg>
            <Node style={{ left: '3%', top: '36%' }} icon={Monitor} title={t('viz.node.client')} detail={scenario === 'retry' ? t('viz.node.clientRetry') : t('viz.node.requests')} />
            <Node style={{ left: '37%', top: '36%' }} icon={Server} title={t('viz.node.api')} detail={t('viz.node.orchestrator')} active={tick > 12 && tick < 80} />
            <Node style={{ right: '8%', top: '36%' }} icon={Database} title="Postgres" detail={scenario === 'race' ? t('viz.node.pgFree', { n: free }) : t('viz.node.pgTruth')} lock active={tick > 25 && tick < 78} />
            <Node style={{ right: '7%', top: '4%' }} dim icon={Zap} title={t('viz.node.cache')} detail={t('viz.node.cacheDetail')} active={scenario === 'retry' && tick > 65} />
            <Node style={{ right: '7%', bottom: '3%' }} icon={CreditCard} title={t('viz.node.payment')} detail={t('viz.node.paymentDetail')} active={scenario === 'saga' && tick > 35 && tick < 67} />

            {dots.map((d) => {
              const phase = Math.min(1, Math.max(0, (tick - d * 2) / 80));
              const left = 9 + phase * 74;
              const top = 47 + ((d % 4) - 1.5) * 4;
              const rejected = scenario === 'race' && d >= free0 && tick > 80;
              const cls = rejected ? 'bad' : tick > 70 ? 'good' : tick > 25 && left > 60 ? 'warn' : 'info';
              return (
                <div key={d} className={`req-dot ${cls}`} style={{ left: `${left}%`, top: `${top}%`, opacity: rejected ? Math.max(0, (100 - tick) / 20) : 1 }}>
                  <span className="sr-only">Request {d + 1}</span>
                </div>
              );
            })}
            {current && <div className={`viz-msg ${SIGNAL[current.signal]}`}>{current.message}</div>}
          </div>

          <div className="viz-legend">
            {[['info', t('viz.processing')], ['warn', t('viz.waiting')], ['good', t('viz.succeeded')], ['bad', t('viz.rejected')]].map(([c, l]) => (
              <span key={l}><i className={`req-dot static ${c}`} />{l}</span>
            ))}
          </div>
        </section>

        <aside className="viz-log">
          <div className="viz-log-head">
            <p>{t('viz.stream')}</p>
            <p>{t('viz.streamSub')}</p>
          </div>
          <div className="viz-log-body">
            {events.length === 0 && <p className="ops-muted">{t('viz.waitingEvents')}</p>}
            {events.slice().reverse().map((e) => (
              <div key={e.id} className="log-entry">
                <div className="log-meta"><span className={SIGNAL[e.signal]}>+{(e.ms / 1000).toFixed(2)}s</span><span className="ops-muted">event.{e.id + 1}</span></div>
                <p>{e.message}</p>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </div>
            ))}
          </div>
          <div className="viz-log-foot">
            <p className="mono">{live ? 'source: liveBackendSource (real API calls)' : 'source: simulatedEventSource'}</p>
            <p>{t('viz.adapter')} <Link to="/loadtest">{t('viz.fullLoadTest')}</Link></p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Node({ style, icon: Icon, title, detail, active = false, lock = false, dim = false }) {
  return (
    <div className={`viz-node ${active ? 'active' : ''} ${dim ? 'dim' : ''}`} style={style}>
      <div className="viz-node-top"><Icon size={24} />{lock && <LockKeyhole size={16} className={active ? 'warn' : 'ops-muted'} />}</div>
      <p className="viz-node-title">{title}</p>
      <p className="ops-muted small">{detail}</p>
    </div>
  );
}
