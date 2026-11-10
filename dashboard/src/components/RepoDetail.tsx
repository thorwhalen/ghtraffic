/**
 * One repo's detail view: its views and clones, stars and forks, and its
 * latest referrers and paths, over the same time range as the dashboard.
 *
 * Opening it pushed a history entry, so the browser Back closes it; the
 * on-page "‹ All repos" does the same (and still works on a pasted link,
 * where there is nothing of ours to go back to).
 */
import { useEffect, useMemo, useRef } from "react";
import { bucketCovered, growth, makeBuckets, maskUncovered, repoSeries, starSummary, totalOver } from "../aggregate";
import { fmtSpan } from "../dates";
import { fmtNum, fmtSigned } from "../format";
import { TimeChart } from "../chart/TimeChart";
import { useStore } from "../store";
import { GRAN_WORD, type View } from "../view";
import { Delta, StarsCard, TopLists } from "./Cards";
import { ChartCard } from "./ChartCard";

function TrafficChart({ view, repo, kind }: { view: View; repo: string; kind: "views" | "clones" }) {
  const { idx, range, gran } = view;
  const buckets = useMemo(() => makeBuckets(range, gran), [range, gran]);
  // Never-collected buckets become null: drawn as a gap, listed as "—".
  const covered = useMemo(() => bucketCovered(idx, kind, buckets), [idx, kind, buckets]);
  const total = useMemo(() => maskUncovered(repoSeries(idx, repo, kind, "count", buckets), covered), [idx, repo, kind, buckets, covered]);
  const uniq = useMemo(() => maskUncovered(repoSeries(idx, repo, kind, "uniques", buckets), covered), [idx, repo, kind, buckets, covered]);
  const series = [
    { key: "count", label: "Total", color: "var(--series-1)", values: total },
    { key: "uniques", label: "Uniques (sum of daily)", color: "var(--series-2)", values: uniq },
  ];
  const name = kind === "views" ? "Views" : "Clones";
  return (
    <ChartCard
      title={`${name} per ${GRAN_WORD[gran]}`}
      subtitle={fmtSpan(range.start, range.end)}
      legend={series.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: "line" as const }))}
      table={{
        columns: ["Period", "Total", "Uniques (sum of daily)"],
        rows: buckets.map((b, i) => [fmtSpan(b.start, b.end), total[i] ?? "—", uniq[i] ?? "—"]),
        numeric: [1, 2],
      }}
    >
      <TimeChart buckets={buckets} series={series} mode="lines" height={200} label={`${name} of ${repo}`} unit={kind} />
    </ChartCard>
  );
}

export function RepoDetail({ view, repo }: { view: View; repo: string }) {
  const closeDetail = useStore((s) => s.closeDetail);
  const { idx, range, prev } = view;
  const info = idx.repos.get(repo);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const one = useMemo(() => [repo], [repo]);

  useEffect(() => {
    document.title = `${repo} · ghtraffic`;
    headingRef.current?.focus();
    return () => {
      document.title = "ghtraffic";
    };
  }, [repo]);

  const figures = useMemo(() => {
    const t = (kind: "views" | "clones") => {
      const cur = totalOver(idx, one, kind, "count", range);
      return { cur, g: growth(cur, totalOver(idx, one, kind, "count", prev), range, idx.dataStart) };
    };
    return { views: t("views"), clones: t("clones"), stars: starSummary(idx, one, "stars", range), forks: starSummary(idx, one, "forks", range) };
  }, [idx, one, range, prev]);

  if (!info) {
    return (
      <section className="detail">
        <button type="button" className="back-btn" onClick={closeDetail}>
          ‹ All repos
        </button>
        <div className="card empty">
          <h2>{repo}</h2>
          <p>This repository is not in the loaded data.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="detail" aria-labelledby="detail-title">
      <button type="button" className="back-btn" onClick={closeDetail}>
        ‹ All repos
      </button>
      <header className="detail-head">
        <h1 id="detail-title" ref={headingRef} tabIndex={-1}>
          <span className="repo-owner">{info.owner}/</span>
          {repo.slice(info.owner.length + 1)}
        </h1>
        <p className="detail-meta">
          {info.private ? <span className="tag">private</span> : <span className="tag">public</span>}
          {info.fork && <span className="tag">fork</span>}
          {info.archived && <span className="tag">archived</span>}
          {info.language && <span>{info.language}</span>}
          <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
            Open on GitHub ↗
          </a>
        </p>
        {info.description && <p className="muted">{info.description}</p>}
      </header>

      <section className="kpis" aria-label="Key figures">
        <div className="tile">
          <div className="tile-label">Views</div>
          <div className="tile-value">{fmtNum(figures.views.cur)}</div>
          <div className="tile-delta">
            <Delta g={figures.views.g} />
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Clones</div>
          <div className="tile-value">{fmtNum(figures.clones.cur)}</div>
          <div className="tile-delta">
            <Delta g={figures.clones.g} />
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Stars</div>
          <div className="tile-value">{fmtNum(figures.stars.now)}</div>
          <div className="tile-delta muted">{fmtSigned(figures.stars.gained)} in range</div>
        </div>
        <div className="tile">
          <div className="tile-label">Forks</div>
          <div className="tile-value">{fmtNum(figures.forks.now)}</div>
          <div className="tile-delta muted">{fmtSigned(figures.forks.gained)} in range</div>
        </div>
      </section>

      <div className="grid">
        <TrafficChart view={view} repo={repo} kind="views" />
        <TrafficChart view={view} repo={repo} kind="clones" />
        <StarsCard view={view} repos={one} title="Stars and forks" />
        <TopLists view={view} repos={one} />
      </div>
    </section>
  );
}
