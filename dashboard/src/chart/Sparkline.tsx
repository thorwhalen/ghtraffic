/**
 * A word-sized trend line: the de-emphasis hue for the shape, the accent for the
 * latest point (dataviz stat-tile rule). Decorative: the numbers it summarises
 * are always printed beside it, so it is hidden from screen readers.
 */
import { linear } from "./scale";

export function Sparkline({ values, width = 80, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const pad = 3; // keep the end dot (r=2.5) inside the box
  const x = linear([0, Math.max(1, values.length - 1)], [pad, width - pad]);
  const y = linear([0, max], [height - pad, pad]);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  return (
    // viewBox + preserveAspectRatio="none": CSS may narrow it on phones and the line still fits.
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} className="spark-line" />
      <circle cx={x(last)} cy={y(values[last])} r={2.5} className="spark-dot" />
    </svg>
  );
}
