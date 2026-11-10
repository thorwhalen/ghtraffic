/**
 * A time-series chart in plain SVG: stacked areas or lines over buckets.
 *
 * Follows the dataviz mark specs: 2px lines with round joins, area fills as a
 * light wash of the series hue, hairline solid gridlines, one y-axis from 0,
 * markers r=4 with a 2px surface ring, direct end-labels only for 2-4 series
 * (and only when they do not collide), and a crosshair that snaps to the
 * nearest bucket and lists every series in one tooltip.
 *
 * Interaction works the same with a mouse, a finger (drag sideways to scrub;
 * vertical drags still scroll the page) and the keyboard (focus the chart,
 * then arrow keys).
 */
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Bucket } from "../aggregate";
import { fmtDay, fmtMonth, fmtSpan } from "../dates";
import { fmtFull, fmtNum } from "../format";
import { linear, niceTicks, tickIndices } from "./scale";
import { useWidth } from "./useWidth";

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour (a `var(--series-n)` token). */
  color: string;
  values: (number | null)[];
}

export interface TimeChartProps {
  buckets: Bucket[];
  series: ChartSeries[];
  mode: "stack" | "lines";
  /** Total height including the x-axis band (so the card never scrolls inside). */
  height?: number;
  /** Accessible name, e.g. "Views per week, stacked by owner". */
  label: string;
  /** Unit word for the tooltip ("views"). */
  unit: string;
  /** Draw a light area wash under a single line. */
  wash?: boolean;
}

const AXIS_BAND = 22; // px reserved under the plot for x labels
const TOP_PAD = 10;
const CHAR_W = 7; // approx. width of one 12px label character, for layout only

function xLabel(b: Bucket, isMonth: boolean): string {
  return isMonth ? fmtMonth(b.key, { short: true }) : fmtDay(b.start);
}

export function TimeChart({ buckets, series, mode, height = 240, label, unit, wash = false }: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const n = buckets.length;
  const isMonth = n > 0 && buckets[0].key.endsWith("-01") && buckets.every((b) => b.key.endsWith("-01")) && n < 40;
  const stacked = mode === "stack";

  // Cumulative tops for the stack: tops[s][i] = sum of series 0..s at bucket i.
  const tops = useMemo(() => {
    const acc = new Array<number>(n).fill(0);
    return series.map((s) =>
      s.values.map((v, i) => {
        if (!stacked || v === null) return v; // null = never collected: a gap, not a zero
        acc[i] += v;
        return acc[i];
      }),
    );
  }, [series, n, stacked]);

  const max = Math.max(0, ...tops.flat().map((v) => v ?? 0));
  const ticks = niceTicks(max, height < 200 ? 3 : 4);
  const yTop = ticks[ticks.length - 1];
  const fmtTick = yTop >= 10_000 ? fmtNum : fmtFull; // one style per axis
  const left = Math.max(...ticks.map((t) => fmtTick(t).length)) * CHAR_W + 10;

  // Direct labels: 2-4 series, room on the right, and no collisions.
  const wantDirect = series.length >= 2 && series.length <= 4 && width >= 520;
  const labelW = Math.min(150, Math.max(...series.map((s) => s.label.length)) * CHAR_W + 18);
  const right = width - (wantDirect ? labelW : 12);
  const bottom = height - AXIS_BAND;
  const x = (i: number) => (n <= 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1));
  const y = linear([0, yTop || 1], [bottom, TOP_PAD]);

  const linePath = (vals: (number | null)[], from = 0, to = vals.length - 1) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (i < from || i > to) return;
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** One closed shape per run of non-null buckets, so gaps stay empty. */
  const bandPath = (upper: (number | null)[], lower: (number | null)[] | null) => {
    let d = "";
    let i = 0;
    while (i < upper.length) {
      if (upper[i] === null) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < upper.length && upper[j + 1] !== null) j++;
      const idx = Array.from({ length: j - i + 1 }, (_, k) => i + k);
      const up = idx.map((k) => `${x(k).toFixed(1)},${y(upper[k] ?? 0).toFixed(1)}`);
      const down = idx.map((k) => `${x(k).toFixed(1)},${y(lower?.[k] ?? 0).toFixed(1)}`).reverse();
      d += `M${up.join("L")}L${down.join("L")}Z`;
      i = j + 1;
    }
    return d;
  };

  // A period the range cuts short (a week or month still in progress) holds
  // fewer days, so its value drops. The segment into it is drawn dashed, the
  // usual mark for "incomplete", so the drop does not read as a real decline.
  const firstPartial = n > 2 && buckets[0].partial;
  const lastPartial = n > 2 && buckets[n - 1].partial;
  const solidFrom = firstPartial ? 1 : 0;
  const solidTo = lastPartial ? n - 2 : n - 1;
  const drawLine = (vals: (number | null)[], color: string) => (
    <>
      <path d={linePath(vals, solidFrom, solidTo)} stroke={color} className="line" />
      {firstPartial && <path d={linePath(vals, 0, 1)} stroke={color} className="line partial" />}
      {lastPartial && <path d={linePath(vals, n - 2, n - 1)} stroke={color} className="line partial" />}
    </>
  );

  const direct = useMemo(() => {
    if (!wantDirect || n === 0) return null;
    const last = n - 1;
    const items = series.map((s, k) => {
      const upper = tops[k][last] ?? 0;
      const lower = stacked && k > 0 ? (tops[k - 1][last] ?? 0) : stacked ? 0 : upper;
      return { s, yy: y((upper + lower) / 2) };
    });
    const sorted = [...items].sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].yy - sorted[i - 1].yy < 14) return null; // collide -> legend only
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantDirect, n, series, tops, stacked, yTop, height]);

  const xTicks = tickIndices(n, Math.max(2, Math.floor((right - left) / 72)));

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = n <= 1 ? 0 : Math.round(((px - left) / (right - left)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setHover((h) => Math.max(0, Math.min(n - 1, (h ?? (d > 0 ? -1 : n)) + d)));
    } else if (e.key === "Escape") setHover(null);
  };

  const h = hover !== null && hover < n ? hover : null;
  const total = h === null ? 0 : series.reduce((a, s) => a + (s.values[h] ?? 0), 0);
  const tipLeft = h !== null && x(h) > width * 0.55;

  return (
    <div className="timechart" ref={ref} style={{ height: height + (firstPartial || lastPartial ? 18 : 0) }}>
      <svg
        width={width}
        height={height}
        role="group"
        aria-label={`${label}. Use the arrow keys to read values; the table view lists them all.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={left} y={0} width={Math.max(0, right - left)} height={bottom + 1} />
          </clipPath>
        </defs>
        {/* Gridlines and y labels: hairline, solid, recessive. */}
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "axis-base" : "gridline"} x1={left} x2={right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} className="tick" x={x(i)} y={bottom + 16} textAnchor={i === n - 1 && n > 1 ? "end" : i === 0 && n > 1 ? "start" : "middle"}>
            {xLabel(buckets[i], isMonth)}
          </text>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s, k) =>
            stacked ? (
              <g key={s.key}>
                <path d={bandPath(tops[k], k > 0 ? tops[k - 1] : null)} fill={s.color} className="band" />
                {drawLine(tops[k], s.color)}
              </g>
            ) : (
              <g key={s.key}>
                {wash && series.length === 1 && <path d={bandPath(s.values, null)} fill={s.color} className="wash" />}
                {drawLine(s.values, s.color)}
              </g>
            ),
          )}
        </g>
        {direct?.map(({ s, yy }) => (
          <g key={s.key} className="direct-label">
            <line x1={right + 6} x2={right + 14} y1={yy} y2={yy} stroke={s.color} />
            <text x={right + 18} y={yy} dy="0.32em">
              {s.label}
            </text>
          </g>
        ))}
        {h !== null && (
          <g className="crosshair" pointerEvents="none">
            <line x1={x(h)} x2={x(h)} y1={TOP_PAD} y2={bottom} />
            {series.map((s, k) =>
              tops[k][h] === null ? null : <circle key={s.key} cx={x(h)} cy={y(tops[k][h] ?? 0)} r={4} fill={s.color} className="marker" />,
            )}
          </g>
        )}
        {/* The hit target: the whole plot, not the 2px lines. */}
        <rect
          className="hit"
          x={left - 8}
          y={0}
          width={Math.max(0, right - left + 16)}
          height={bottom}
          onPointerDown={pick}
          onPointerMove={pick}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        />
      </svg>
      {(firstPartial || lastPartial) && <p className="partial-note">Dashed: a period the range cuts short (fewer days).</p>}
      {h !== null && (
        <div className={`tooltip ${tipLeft ? "flip" : ""}`} style={tipLeft ? { right: width - x(h) + 12 } : { left: x(h) + 12 }} role="status">
          <div className="tip-head">
            {fmtSpan(buckets[h].start, buckets[h].end)}
            {buckets[h].partial && <span className="muted"> (partial)</span>}
          </div>
          {series.every((s) => s.values[h] === null) && <div className="tip-name">No data collected</div>}
          {series.some((s) => s.values[h] !== null) && (stacked ? [...series].reverse() : series).map((s) => (
            <div className="tip-row" key={s.key}>
              <span className="key-line" style={{ background: s.color }} />
              <strong>{s.values[h] === null ? "—" : fmtFull(s.values[h] ?? 0)}</strong>
              <span className="tip-name">{s.label}</span>
            </div>
          ))}
          {stacked && series.length > 1 && series.some((s) => s.values[h] !== null) && (
            <div className="tip-row tip-total">
              <span className="key-line" />
              <strong>{fmtFull(total)}</strong>
              <span className="tip-name">total {unit}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
