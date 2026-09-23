import { useI18n } from '../i18n.jsx';

const W = 640;
const H = 220;
const P = { l: 44, r: 12, t: 12, b: 28 };

// Cumulative requests answered over time. Hand-drawn SVG: no chart library needed for three lines.
export function TimelineChart({ samples, total }) {
  const { t } = useI18n();
  if (!samples?.length) return <div className="chart-empty">{t('lt.chartEmpty')}</div>;
  const tMax = Math.max(1000, samples.at(-1).t_ms);
  const x = (ms) => P.l + (ms / tMax) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / Math.max(1, total)) * (H - P.t - P.b);
  const line = (key) => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t_ms).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  const area = `${line('completed')} L${x(samples.at(-1).t_ms).toFixed(1)},${y(0)} L${x(samples[0].t_ms).toFixed(1)},${y(0)} Z`;
  const yTicks = [0, 0.5, 1].map((f) => Math.round(f * total));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * tMax));

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('lt.chartLabel')}>
      {yTicks.map((v) => (
        <g key={v}>
          <line className="grid" x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} />
          <text className="axis" x={P.l - 6} y={y(v) + 4} textAnchor="end">{v}</text>
        </g>
      ))}
      {xTicks.map((ms) => (
        <text key={ms} className="axis" x={x(ms)} y={H - 8} textAnchor="middle">{(ms / 1000).toFixed(1)}s</text>
      ))}
      <path d={area} className="area-completed" />
      <path d={line('completed')} className="line-completed" />
      <path d={line('sold_out')} className="line-soldout" />
      <path d={line('success')} className="line-success" />
    </svg>
  );
}

export function Histogram({ buckets }) {
  const { t } = useI18n();
  if (!buckets?.length) return null;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = (W - P.l - P.r) / buckets.length;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H - 30}`} role="img" aria-label={t('lt.histLabel')}>
      {buckets.map((b, i) => {
        const h = (b.count / max) * (H - 30 - P.t - P.b);
        return (
          <g key={i}>
            <rect className="bar" x={P.l + i * bw + 1} y={H - 30 - P.b - h} width={Math.max(1, bw - 2)} height={h}>
              <title>{`${b.from_ms}–${b.to_ms} ms: ${b.count}`}</title>
            </rect>
          </g>
        );
      })}
      <text className="axis" x={P.l} y={H - 34} textAnchor="start">{buckets[0].from_ms} ms</text>
      <text className="axis" x={W - P.r} y={H - 34} textAnchor="end">{buckets.at(-1).to_ms} ms</text>
    </svg>
  );
}
