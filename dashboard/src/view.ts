/**
 * The shared, derived "view" every card reads: which repos, which days, which
 * buckets. Computed once per (dataset, filters) change and memoised, so the
 * cards agree on the same slice (dataviz: filters scope everything below them).
 */
import { useMemo } from "react";
import {
  makeBuckets,
  previousRange,
  resolveGran,
  resolveRange,
  selectRepos,
  type Bucket,
  type Gran,
  type Index,
  type Range,
} from "./aggregate";
import type { Filters } from "./filters";
import { useStore } from "./store";

export interface View {
  idx: Index;
  f: Filters;
  repos: string[];
  range: Range;
  prev: Range;
  gran: Gran;
  buckets: Bucket[];
  /** Referrers/paths snapshot day: the `asof` filter if inside the range, else the range end. */
  asOf: string;
}

export function computeView(idx: Index, f: Filters): View {
  const range = resolveRange(f, idx);
  const gran = resolveGran(f.gran, range);
  return {
    idx,
    f,
    repos: selectRepos(idx, f),
    range,
    prev: previousRange(range),
    gran,
    buckets: makeBuckets(range, gran),
    asOf: f.asof && f.asof <= range.end ? f.asof : range.end,
  };
}

export function useView(): View | null {
  const idx = useStore((s) => s.index);
  const f = useStore((s) => s.route.filters);
  return useMemo(() => (idx ? computeView(idx, f) : null), [idx, f]);
}

/** "Views", or "Views (sum of daily uniques)" — uniques are never presented as additive. */
export function metricLabel(kind: "views" | "clones", measure: "count" | "uniques", { short = false } = {}): string {
  const k = kind === "views" ? "Views" : "Clones";
  if (measure === "count") return k;
  return short ? `${k} · Σ daily uniques` : `${k} (sum of daily uniques)`;
}

export const GRAN_WORD: Record<Gran, string> = { day: "day", week: "week", month: "month" };
