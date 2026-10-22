import { useState } from 'react';
import { fmtNumber } from '../lib/format.js';

/**
 * Single-series daily bar chart (inline SVG, no library). One series → no legend:
 * the title names it. Hover/focus shows a tooltip; a visually hidden table gives
 * the same numbers to screen readers. Thin bars, 4px rounded tops, 2px gaps,
 * recessive grid with a zero baseline.
 */
export default function BarChart({ title, data, valueKey, unit = '' }) {
  const [hover, setHover] = useState(null);
  const W = 640; const H = 180; const PAD_L = 34; const PAD_B = 22; const PAD_T = 8;
  const max = Math.max(1, ...data.map((d) => d[valueKey] || 0));
  const nice = niceMax(max);
  const plotW = W - PAD_L - 4; const plotH = H - PAD_B - PAD_T;
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(18, slot - 2));
  const y = (v) => PAD_T + plotH - (v / nice) * plotH;
  const total = data.reduce((a, d) => a + (d[valueKey] || 0), 0);
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(data.length / 6);

  return (
    <figure className="chart">
      <figcaption className="chart-head"><span className="strong">{title}</span><span className="small muted">{fmtNumber(total)} total</span></figcaption>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${fmtNumber(total)} over ${data.length} days`} preserveAspectRatio="none">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={W} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-base' : 'chart-grid'} />
              <text x={PAD_L - 6} y={y(t) + 4} className="chart-tick" textAnchor="end">{fmtNumber(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const v = d[valueKey] || 0;
            const x = PAD_L + i * slot + (slot - barW) / 2;
            const h = Math.max(0, y(0) - y(v));
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={-1}>
                <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" />
                {v > 0 ? <path d={roundedTop(x, y(v), barW, h, Math.min(4, barW / 2, h))} className={`chart-bar ${hover === i ? 'is-hover' : ''}`} /> : null}
                {i % labelEvery === 0 ? <text x={x + barW / 2} y={H - 6} className="chart-tick" textAnchor="middle">{d.day.slice(5)}</text> : null}
              </g>
            );
          })}
        </svg>
        {hover !== null ? (
          <div className="chart-tip" style={{ left: `${((PAD_L + hover * slot + slot / 2) / W) * 100}%` }} role="status">
            <span className="small muted">{data[hover].day}</span>
            <strong>{fmtNumber(data[hover][valueKey] || 0)}{unit}</strong>
          </div>
        ) : null}
      </div>
      <table className="sr-only"><caption>{title} by day</caption><thead><tr><th>Day</th><th>Value</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d[valueKey] || 0}</td></tr>)}</tbody></table>
    </figure>
  );
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Bar path with rounded top corners, flat on the baseline. */
function roundedTop(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.max(0, Math.min(r, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}
