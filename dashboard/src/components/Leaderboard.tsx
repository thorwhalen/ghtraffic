/**
 * The repo leaderboard: a sortable table, compact on phones, each row opening
 * that repo's detail view.
 *
 * The columns are declared once, as a Zod schema whose field descriptions are
 * the headers (schema as the single source of truth for the table's shape);
 * the per-column rendering and the phone/desktop choice sit beside it.
 */
import { useMemo } from "react";
import * as z from "zod/mini";
import { leaderboard, sortRows, type LeaderRow } from "../aggregate";
import { LEADERBOARD_TOP, type Filters } from "../filters";
import { fmtNum, fmtPct } from "../format";
import { Sparkline } from "../chart/Sparkline";
import { useStore } from "../store";
import { metricLabel, type View } from "../view";
import { ChartCard, type TableSpec } from "./ChartCard";

/** The leaderboard's columns. `.describe()` is the header text. */
export const LeaderColumns = z.object({
  repo: z.string().check(z.describe("Repository")),
  views: z.number().check(z.describe("Views")),
  uniques: z.number().check(z.describe("Σ daily uniques")),
  clones: z.number().check(z.describe("Clones")),
  stars: z.nullable(z.number()).check(z.describe("Stars")),
  growth: z.nullable(z.number()).check(z.describe("Growth")),
});
type ColKey = keyof z.infer<typeof LeaderColumns>;
const COLS = Object.keys(LeaderColumns.shape) as ColKey[];
const header = (k: ColKey): string => (z.globalRegistry.get(LeaderColumns.shape[k])?.description as string | undefined) ?? k;

/** Columns hidden on phones; the selected metric column is always kept. */
const WIDE_ONLY: ColKey[] = ["uniques", "clones", "stars"];

function cell(r: LeaderRow, k: ColKey) {
  switch (k) {
    case "repo":
      return null; // rendered separately (it is the button)
    case "stars":
      return r.stars === null ? "—" : fmtNum(r.stars);
    case "growth":
      if (r.growth.pct === null) return <span className="muted">—</span>;
      return (
        <span className={`delta delta-${r.growth.pct > 0 ? "up" : r.growth.pct < 0 ? "down" : "flat"}`}>
          <span aria-hidden="true">{r.growth.pct > 0 ? "▲" : r.growth.pct < 0 ? "▼" : "■"}</span> {fmtPct(r.growth.pct)}
        </span>
      );
    default:
      return fmtNum(r[k]);
  }
}

export function Leaderboard({ view }: { view: View }) {
  const { idx, repos, f, range } = view;
  const setFilters = useStore((s) => s.setFilters);
  const openDetail = useStore((s) => s.openDetail);
  const all = useMemo(
    () => sortRows(leaderboard(idx, repos, { kind: f.kind, measure: f.measure, range }), f.sort, f.desc),
    [idx, repos, f.kind, f.measure, range, f.sort, f.desc],
  );
  // With hundreds of repos, most have no traffic in a short range: hide those
  // by default, and show the top rows by the current sort until "Show all".
  const active = useMemo(() => all.filter((r) => r.views > 0 || r.clones > 0), [all]);
  const listed = f.lbzero ? all : active;
  const zeroCount = all.length - active.length;
  const rows = f.lball ? listed : listed.slice(0, LEADERBOARD_TOP);
  // The metric the growth and trend columns follow, and the one kept on phones.
  const metricCol: ColKey = f.kind === "clones" ? "clones" : f.measure === "uniques" ? "uniques" : "views";

  const sortBy = (k: ColKey) => setFilters({ sort: k as Filters["sort"], desc: f.sort === k ? !f.desc : k !== "repo" });

  const table: TableSpec = {
    columns: [...COLS.map(header), "Trend points"],
    rows: listed.map((r) => [r.repo, r.views, r.uniques, r.clones, r.stars ?? "—", r.growth.pct === null ? "—" : fmtPct(r.growth.pct), r.spark.join(" ")]),
    numeric: [1, 2, 3, 4],
  };

  return (
    <ChartCard
      className="span-2"
      title="Repositories"
      subtitle={`${rows.length < listed.length ? `Top ${rows.length} of ${listed.length}` : `${listed.length} repos`}${
        f.lbzero || !zeroCount ? "" : " with traffic"
      }, by ${header(f.sort as ColKey)}. Growth and trend: ${metricLabel(f.kind, f.measure).toLowerCase()} vs the previous equal period. Tap a repo for details.`}
      table={table}
    >
      <div className="table-scroll lb-scroll">
        <table className="leaderboard">
          <thead>
            <tr>
              {COLS.map((k) => (
                <th
                  key={k}
                  className={`${k === "repo" ? "" : "num"} ${WIDE_ONLY.includes(k) && k !== metricCol ? "wide-only" : ""} ${k === "views" && metricCol !== "views" ? "wide-only" : ""}`}
                  aria-sort={f.sort === k ? (f.desc ? "descending" : "ascending") : "none"}
                >
                  <button type="button" className="sort-btn" onClick={() => sortBy(k)}>
                    {header(k)}
                    <span className="sort-ind" aria-hidden="true">
                      {f.sort === k ? (f.desc ? "↓" : "↑") : ""}
                    </span>
                  </button>
                </th>
              ))}
              <th className="trend-col">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.repo} onClick={() => openDetail(r.repo)}>
                <td className="repo-cell">
                  <button type="button" className="repo-btn" onClick={(e) => (e.stopPropagation(), openDetail(r.repo))}>
                    <span className="repo-owner">{r.info.owner}/</span>
                    <span className="repo-name">{r.repo.slice(r.info.owner.length + 1)}</span>
                  </button>
                  {(r.info.private || r.info.archived || r.info.fork) && (
                    <span className="repo-tags">
                      {r.info.private && <span className="tag">private</span>}
                      {r.info.archived && <span className="tag">archived</span>}
                      {r.info.fork && <span className="tag">fork</span>}
                    </span>
                  )}
                </td>
                {COLS.filter((k) => k !== "repo").map((k) => (
                  <td
                    key={k}
                    className={`num ${WIDE_ONLY.includes(k) && k !== metricCol ? "wide-only" : ""} ${k === "views" && metricCol !== "views" ? "wide-only" : ""}`}
                  >
                    {cell(r, k)}
                  </td>
                ))}
                <td className="trend-col">
                  <Sparkline values={r.spark} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(listed.length > LEADERBOARD_TOP || zeroCount > 0) && (
        <div className="lb-more">
          {listed.length > LEADERBOARD_TOP && (
            <button type="button" className="chip-btn" onClick={() => setFilters({ lball: !f.lball })}>
              {f.lball ? `Show top ${LEADERBOARD_TOP}` : `Show all (${listed.length})`}
            </button>
          )}
          {zeroCount > 0 && (
            <label className="toggle">
              <input type="checkbox" checked={f.lbzero} onChange={(e) => setFilters({ lbzero: e.target.checked })} />
              Include {zeroCount} repo{zeroCount > 1 ? "s" : ""} with no views or clones in this range
            </label>
          )}
        </div>
      )}
    </ChartCard>
  );
}
