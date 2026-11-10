/**
 * The dashboard's cards: KPI tiles, the main time series, top referrers and
 * paths, stars and forks. Each card derives its numbers from the shared `View`
 * with useMemo (pure functions from aggregate.ts), so all cards agree.
 */
import { useMemo } from "react";
import {
  bucketCovered,
  maskUncovered,
  groupedSeries,
  growth,
  repoSeries,
  snapshotDates,
  starSeries,
  starSummary,
  topPaths,
  topReferrers,
  totalOver,
  trailingBuckets,
  sparkGran,
  windowSummary,
  type Bucket,
  type Growth,
  type TopResult,
} from "../aggregate";
import { assignSlots, OTHER_COLOR, slotColor } from "../colors";
import { fmtDay, fmtSpan } from "../dates";
import { GRANS } from "../filters";
import { fmtNum, fmtPct, fmtSigned } from "../format";
import { RankedBars } from "../chart/RankedBars";
import { Sparkline } from "../chart/Sparkline";
import { TimeChart, type ChartSeries } from "../chart/TimeChart";
import { useStore } from "../store";
import { GRAN_WORD, metricLabel, type View } from "../view";
import { ChartCard, type TableSpec } from "./ChartCard";
import { Segmented } from "./ui";

// ------------------------------------------------------------------ KPI tiles

/** Signed change with an arrow, so direction never relies on colour alone. */
export function Delta({ g, vs = "vs previous period" }: { g: Growth; vs?: string }) {
  if (g.pct === null) return <span className="delta muted">— {g.note ?? ""}</span>;
  const dir = g.pct > 0 ? "up" : g.pct < 0 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
  return (
    <span className={`delta delta-${dir}`}>
      <span aria-hidden="true">{arrow}</span> {fmtPct(g.pct)}
      <span className="muted"> {vs}{g.partial ? " (partial)" : ""}</span>
    </span>
  );
}

function Tile({ label, value, children, spark }: { label: string; value: string; children?: React.ReactNode; spark?: number[] }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {children && <div className="tile-delta">{children}</div>}
      {spark && spark.length > 1 && <Sparkline values={spark} width={96} height={22} />}
    </div>
  );
}

/** Sum of a kind+measure across the selection, per bucket (for tile sparklines). */
function totalsPerBucket(view: View, kind: "views" | "clones", measure: "count" | "uniques", buckets: Bucket[]): number[] {
  const out = new Array<number>(buckets.length).fill(0);
  for (const repo of view.repos) repoSeries(view.idx, repo, kind, measure, buckets).forEach((v, i) => (out[i] += v));
  return out;
}

export function KpiRow({ view }: { view: View }) {
  const { idx, repos, range, prev, f } = view;
  const m = f.measure;
  // Whole periods counted back from the range end, so the trend's last point is not a partial week.
  const buckets = useMemo(() => trailingBuckets(range, sparkGran(range)), [range]);
  const data = useMemo(() => {
    const traffic = (["views", "clones"] as const).map((kind) => {
      const cur = totalOver(idx, repos, kind, m, range);
      const before = totalOver(idx, repos, kind, m, prev);
      return { kind, cur, g: growth(cur, before, range, idx.dataStart), spark: totalsPerBucket(view, kind, m, buckets) };
    });
    return {
      traffic,
      win: windowSummary(idx, repos, "views", range.end),
      stars: starSummary(idx, repos, "stars", range),
      forks: starSummary(idx, repos, "forks", range),
    };
  }, [idx, repos, range, prev, m, buckets, view]);

  return (
    <section className="kpis" aria-label="Key figures">
      {data.traffic.map((t) => (
        <Tile key={t.kind} label={metricLabel(t.kind, m, { short: true })} value={fmtNum(t.cur)} spark={t.spark}>
          <Delta g={t.g} />
        </Tile>
      ))}
      <Tile label="Unique visitors, 14 days" value={data.win.to ? fmtNum(data.win.uniques) : "—"}>
        <span className="muted">
          {data.win.to
            ? `to ${fmtDay(data.win.to, { year: true })}${data.win.repos > 1 ? `, summed over ${data.win.repos} repos` : ""}`
            : "no snapshot in range"}
        </span>
      </Tile>
      <Tile label="Stars" value={fmtNum(data.stars.now)}>
        <span className="muted">{fmtSigned(data.stars.gained)} in range</span>
      </Tile>
      <Tile label="Forks" value={fmtNum(data.forks.now)}>
        <span className="muted">{fmtSigned(data.forks.gained)} in range</span>
      </Tile>
    </section>
  );
}

// ------------------------------------------------------------------ main series

const GRAN_LABELS = { auto: "Auto", day: "Day", week: "Week", month: "Month" } as const;

/** Bucket label for tables: the covered span, flagged when cut short by the range. */
const periodLabel = (b: Bucket) => fmtSpan(b.start, b.end) + (b.partial ? " (partial)" : "");

export function MainChart({ view }: { view: View }) {
  const { idx, repos, f, buckets, gran } = view;
  const setFilters = useStore((s) => s.setFilters);
  const series = useMemo(
    () => groupedSeries(idx, repos, { kind: f.kind, measure: f.measure, group: f.group, buckets }),
    [idx, repos, f.kind, f.measure, f.group, buckets],
  );
  const chartSeries: ChartSeries[] = useMemo(() => {
    const slots = assignSlots(
      series.filter((s) => !s.other).map((s) => s.key),
      f.group === "owner" ? idx.ownerRank : idx.repoRank,
    );
    const covered = bucketCovered(idx, f.kind, buckets);
    return series.map((s) => ({
      key: s.key,
      label: s.label,
      values: maskUncovered(s.values, covered),
      color: s.other ? OTHER_COLOR : slotColor(slots.get(s.key) ?? 0),
    }));
  }, [series, f.group, f.kind, idx, buckets]);

  const metric = metricLabel(f.kind, f.measure);
  const table: TableSpec = {
    columns: ["Period", ...chartSeries.map((s) => s.label), "Total"],
    rows: buckets.map((b, i) =>
      chartSeries.every((s) => s.values[i] === null)
        ? [periodLabel(b), ...chartSeries.map(() => "—"), "not collected"]
        : [periodLabel(b), ...chartSeries.map((s) => s.values[i] ?? 0), chartSeries.reduce((a, s) => a + (s.values[i] ?? 0), 0)],
    ),
    numeric: chartSeries.map((_, i) => i + 1).concat(chartSeries.length + 1),
  };
  return (
    <ChartCard
      className="span-2"
      title={`${metric} per ${GRAN_WORD[gran]}`}
      subtitle={`${f.group === "owner" ? "Stacked by owner" : "Top repos, stacked"} · ${fmtSpan(view.range.start, view.range.end)}`}
      legend={chartSeries.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: "area" as const }))}
      controls={
        <>
          <Segmented label="Group by" options={["owner", "repo"] as const} labels={{ owner: "Owners", repo: "Repos" }} value={f.group} onChange={(group) => setFilters({ group })} />
          <Segmented label="Granularity" options={GRANS} labels={GRAN_LABELS} value={f.gran} onChange={(g) => setFilters({ gran: g })} />
        </>
      }
      table={table}
    >
      {chartSeries.length ? (
        <TimeChart buckets={buckets} series={chartSeries} mode="stack" height={260} label={`${metric} per ${gran}`} unit={f.kind} />
      ) : (
        <p className="muted pad">No {f.kind} in this range for the selected repos.</p>
      )}
    </ChartCard>
  );
}

// ------------------------------------------------------------------ referrers & paths

/** "14 days to Nov 6, 2026", or the span of snapshot dates when repos differ. */
export function snapshotCaption(t: Pick<TopResult, "from" | "to" | "repos">): string {
  if (!t.to) return "No snapshot at or before this date";
  if (t.from === t.to) return `14 days to ${fmtDay(t.to, { year: true })}`;
  return `Latest 14-day snapshot per repo, taken ${fmtSpan(t.from!, t.to)}`;
}

function topTable(t: TopResult, what: string): TableSpec {
  return {
    columns: [what, "Views", "Uniques (sum over repos)", "Repos"],
    rows: t.items.map((i) => [i.label, i.count, i.uniques, i.repos.join(", ")]),
    numeric: [1, 2],
  };
}

export function TopLists({ view, repos = view.repos }: { view: View; repos?: string[] }) {
  const { idx, asOf, f } = view;
  const setFilters = useStore((s) => s.setFilters);
  const refs = useMemo(() => topReferrers(idx, repos, asOf), [idx, repos, asOf]);
  const paths = useMemo(() => topPaths(idx, repos, asOf), [idx, repos, asOf]);
  const dates = useMemo(() => snapshotDates(idx, repos, view.range.end), [idx, repos, view.range.end]);
  const multi = repos.length > 1;
  const note = (r: string[]) => (multi && r.length > 1 ? `${r.length} repos` : multi ? r[0] : undefined);

  const asOfPicker = dates.length > 1 && (
    <label className="asof">
      <span className="sr-only">Snapshot</span>
      <select value={f.asof && dates.includes(f.asof) ? f.asof : ""} onChange={(e) => setFilters({ asof: e.target.value || undefined })}>
        <option value="">Latest</option>
        {dates.map((d) => (
          <option key={d} value={d}>
            {fmtDay(d, { year: true })}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <ChartCard title="Top referrers" subtitle={snapshotCaption(refs)} controls={asOfPicker} table={topTable(refs, "Referrer")}>
        {refs.items.length ? (
          <RankedBars items={refs.items.map((i) => ({ key: i.key, label: i.label, value: i.count, note: note(i.repos) }))} />
        ) : (
          <p className="muted pad">No referrer snapshot for this selection.</p>
        )}
      </ChartCard>
      <ChartCard title="Top paths" subtitle={snapshotCaption(paths)} controls={asOfPicker} table={topTable(paths, "Path")}>
        {paths.items.length ? (
          <RankedBars items={paths.items.map((i) => ({ key: i.key, label: i.label, value: i.count }))} />
        ) : (
          <p className="muted pad">No path snapshot for this selection.</p>
        )}
      </ChartCard>
    </>
  );
}

// ------------------------------------------------------------------ stars & forks

export function StarsCard({ view, repos = view.repos, title = "Stars and forks", className = "" }: { view: View; repos?: string[]; title?: string; className?: string }) {
  const { idx, buckets, gran } = view;
  const stars = useMemo(() => starSeries(idx, repos, "stars", buckets), [idx, repos, buckets]);
  const forks = useMemo(() => starSeries(idx, repos, "forks", buckets), [idx, repos, buckets]);
  const table: TableSpec = {
    columns: [`${gran[0].toUpperCase()}${gran.slice(1)} ending`, "Stars", "Forks"],
    rows: buckets.map((b, i) => [fmtDay(b.end, { year: true }), stars[i], forks[i]]),
    numeric: [1, 2],
  };
  return (
    <ChartCard className={className} title={title} subtitle={`${repos.length > 1 ? "Selection total" : "Count"} at the end of each ${GRAN_WORD[gran]}`} table={table}>
      {/* Two charts, not two y-axes: stars and forks live on different scales. */}
      <div className="pair">
        <div>
          <h3 className="mini-title">Stars</h3>
          <TimeChart buckets={buckets} series={[{ key: "stars", label: "Stars", color: "var(--series-1)", values: stars }]} mode="lines" wash height={150} label="Stars over time" unit="stars" />
        </div>
        <div>
          <h3 className="mini-title">Forks</h3>
          <TimeChart buckets={buckets} series={[{ key: "forks", label: "Forks", color: "var(--series-1)", values: forks }]} mode="lines" wash height={150} label="Forks over time" unit="forks" />
        </div>
      </div>
    </ChartCard>
  );
}
