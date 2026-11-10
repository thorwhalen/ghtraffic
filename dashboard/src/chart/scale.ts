/**
 * The two bits of d3 the charts need, written out (no chart library).
 *
 * Decision: the charts are hand-drawn SVG. The dataviz rules this dashboard
 * follows (2px surface gaps and rings, 4px rounded data-ends, a crosshair that
 * snaps to the nearest bucket, a table view per chart) are a few lines each in
 * plain SVG, and fighting a chart library's defaults to get them is not.
 * It also keeps the bundle small (no d3, no Recharts).
 */

/** A linear map from a domain [d0, d1] to a range [r0, r1]. */
export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** A "nice" step (1, 2 or 5 times a power of ten) giving about `count` ticks over [0, max]. */
export function niceStep(max: number, count: number): number {
  if (!(max > 0)) return 1;
  const raw = max / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const err = raw / pow;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  return Math.max(1, mult * pow); // counts are integers: never a fractional step
}

/** Ticks from 0 up to a nice ceiling >= max (the last tick is the axis top). */
export function niceTicks(max: number, count = 4): number[] {
  const step = niceStep(max, count);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

/** Pick about `maxLabels` evenly spaced indices out of `n`, always including the last. */
export function tickIndices(n: number, maxLabels: number): number[] {
  if (n <= 0) return [];
  if (n <= maxLabels) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / Math.max(1, maxLabels));
  const out: number[] = [];
  // Anchor on the last bucket (the most recent), stepping back.
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}
