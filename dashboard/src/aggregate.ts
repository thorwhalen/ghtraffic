/**
 * Pure aggregation over a loaded `Dataset`: everything the charts and tiles show.
 *
 * No React, no DOM, no fetch: every function takes data in and returns numbers
 * out, so it is unit-tested directly (tests/aggregate.test.ts).
 *
 * Two facts about GitHub traffic shape this module:
 * 1. Daily tables omit zero days, so series are filled with zeros over the range.
 * 2. Unique visitors are NOT additive (the same person on two days, or on two
 *    repos, is one unique). Summing daily uniques is still useful, but it is
 *    labelled "sum of daily uniques"; the only true 14-day uniques are the
 *    `windows` snapshots, and summing those across repos is labelled too.
 */
import { addDays, daysBetween, eachDay, monthEnd, monthStart, weekStart } from "./dates";
import { MAX_OWNER_SERIES, TOP_REPOS, type Filters } from "./filters";
import type { Dataset } from "./load";
import type { PathRow, ReferrerRow, RepoRow, WindowRow } from "./schema";

export type Kind = "views" | "clones";
export type Measure = "count" | "uniques";

export interface RepoInfo {
  repo: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string;
  description: string;
}

interface DayValue {
  count: number;
  uniques: number;
}

/** A star/fork/watcher reading after carrying unknown values forward. */
export interface StarPoint {
  date: string;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
}

type Snapshots<R> = Map<string, Map<string, R[]>>; // repo -> fetched -> rows

/** Lookup structures built once per dataset (filters only read them). */
export interface Index {
  repos: Map<string, RepoInfo>;
  /** All owners, most-viewed first over all time: the stable colour order. */
  owners: string[];
  /** Repo -> all-time rank by views (0 = most viewed): the stable colour order. */
  repoRank: Map<string, number>;
  ownerRank: Map<string, number>;
  daily: Record<Kind, Map<string, Map<string, DayValue>>>;
  /** First and last day present in the daily tables. */
  dataStart: string;
  dataEnd: string;
  /** The day ranges end on: the later of manifest.updated and the last data day. */
  anchor: string;
  /**
   * Days the collector actually saw, per kind: any day with a row of that
   * kind, plus the 14-day window before each run (GitHub lists zero days, and
   * they are dropped, so a seen day with no row means 0). A day outside the
   * set was never collected: charts draw it as a gap, not as zero. Per kind,
   * because GitHub's clones history can reach further back than its views.
   */
  covered: Record<Kind, Set<string>>;
  stars: Map<string, StarPoint[]>;
  windows: Map<string, WindowRow[]>;
  referrers: Snapshots<ReferrerRow>;
  paths: Snapshots<PathRow>;
}

// ------------------------------------------------------------------- index

/** GitHub serves the last 14 days of daily traffic. */
export const GITHUB_WINDOW_DAYS = 14;

/** Repo metadata from repos.csv, plus any repo that only appears in traffic rows. */
function repoInfos(rows: RepoRow[], seen: Iterable<string>): Map<string, RepoInfo> {
  const out = new Map<string, RepoInfo>();
  for (const r of rows) {
    out.set(r.repo, {
      repo: r.repo,
      owner: r.owner || r.repo.split("/")[0],
      private: r.private,
      fork: r.fork,
      archived: r.archived,
      language: r.language,
      description: r.description,
    });
  }
  for (const repo of seen) {
    if (!out.has(repo)) {
      out.set(repo, { repo, owner: repo.split("/")[0], private: false, fork: false, archived: false, language: "", description: "" });
    }
  }
  return out;
}

/** Group snapshot rows by repo then fetched date. */
function bySnapshot<R extends { repo: string; fetched: string }>(rows: R[]): Snapshots<R> {
  const out: Snapshots<R> = new Map();
  for (const r of rows) {
    let m = out.get(r.repo);
    if (!m) out.set(r.repo, (m = new Map()));
    const list = m.get(r.fetched);
    if (list) list.push(r);
    else m.set(r.fetched, [r]);
  }
  return out;
}

/**
 * Star rows per repo, sorted by date, with empty forks/watchers replaced by the
 * last known value (backfilled star history has no forks/watchers). Before the
 * first known value they stay `null` (unknown, drawn as nothing, summed as 0).
 */
export function carryForwardStars(rows: Dataset["tables"]["stars"]): Map<string, StarPoint[]> {
  const byRepo = new Map<string, StarPoint[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo) ?? [];
    list.push({ date: r.date, stars: r.stars, forks: r.forks, watchers: r.watchers });
    byRepo.set(r.repo, list);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let last: Omit<StarPoint, "date"> = { stars: null, forks: null, watchers: null };
    for (const p of list) {
      for (const f of ["stars", "forks", "watchers"] as const) {
        if (p[f] === null) p[f] = last[f];
      }
      last = { stars: p.stars, forks: p.forks, watchers: p.watchers };
    }
  }
  return byRepo;
}

export function buildIndex(ds: Dataset): Index {
  const { tables, manifest } = ds;
  const daily: Index["daily"] = { views: new Map(), clones: new Map() };
  const total = new Map<string, number>();
  let dataStart = "";
  let dataEnd = "";
  for (const kind of ["views", "clones"] as const) {
    for (const r of tables[kind]) {
      let m = daily[kind].get(r.repo);
      if (!m) daily[kind].set(r.repo, (m = new Map()));
      m.set(r.date, { count: r.count ?? 0, uniques: r.uniques ?? 0 });
      if (!dataStart || r.date < dataStart) dataStart = r.date;
      if (r.date > dataEnd) dataEnd = r.date;
      if (kind === "views") total.set(r.repo, (total.get(r.repo) ?? 0) + (r.count ?? 0));
    }
  }
  const seen = new Set<string>([
    ...daily.views.keys(),
    ...daily.clones.keys(),
    ...tables.stars.map((r) => r.repo),
    ...tables.windows.map((r) => r.repo),
  ]);
  const repos = repoInfos(tables.repos, seen);

  const covered: Record<Kind, Set<string>> = { views: new Set(), clones: new Set() };
  for (const kind of ["views", "clones"] as const) {
    for (const r of tables[kind]) covered[kind].add(r.date);
    for (const run of tables.runs) {
      const day = run.started_at.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) for (const d of eachDay(addDays(day, -GITHUB_WINDOW_DAYS), day)) covered[kind].add(d);
    }
  }

  const updated = manifest.updated.slice(0, 10);
  const anchor = [updated, dataEnd].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() ?? updated;
  if (!dataStart) dataStart = dataEnd = anchor;

  const byViews = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const repoOrder = [...repos.keys()].map((r) => [r, total.get(r) ?? 0] as [string, number]).sort(byViews);
  const ownerTotals = new Map<string, number>();
  for (const [r, v] of repoOrder) {
    const o = repos.get(r)!.owner;
    ownerTotals.set(o, (ownerTotals.get(o) ?? 0) + v);
  }
  const owners = [...ownerTotals].sort(byViews).map(([o]) => o);

  const windows = new Map<string, WindowRow[]>();
  for (const w of tables.windows) {
    const list = windows.get(w.repo) ?? [];
    list.push(w);
    windows.set(w.repo, list);
  }
  for (const list of windows.values()) list.sort((a, b) => a.fetched.localeCompare(b.fetched));

  return {
    repos,
    owners,
    repoRank: new Map(repoOrder.map(([r], i) => [r, i])),
    ownerRank: new Map(owners.map((o, i) => [o, i])),
    daily,
    dataStart,
    dataEnd,
    anchor,
    covered,
    stars: carryForwardStars(tables.stars),
    windows,
    referrers: bySnapshot(tables.referrers),
    paths: bySnapshot(tables.paths),
  };
}

// ------------------------------------------------------------------- selection

/** Does a repo pass the visibility toggles? */
export function isVisible(info: RepoInfo, f: Pick<Filters, "pub" | "priv" | "forks" | "archived">): boolean {
  return (info.private ? f.priv : f.pub) && (!info.fork || f.forks) && (!info.archived || f.archived);
}

/**
 * The repos the filters select: owner (any of) AND visibility AND repo (any of).
 * Sorted by name.
 */
export function selectRepos(idx: Index, f: Filters): string[] {
  const owners = new Set(f.owners);
  const picked = new Set(f.repos);
  return [...idx.repos.values()]
    .filter((r) => (!owners.size || owners.has(r.owner)) && isVisible(r, f) && (!picked.size || picked.has(r.repo)))
    .map((r) => r.repo)
    .sort();
}

// ------------------------------------------------------------------- time

export interface Range {
  start: string;
  end: string;
}

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

/** The day range a filter selects, ending at the dataset's anchor day. */
/**
 * The day range a filter selects, ending at the dataset's anchor day. The start
 * is clamped to the first day with views/clones data: days before collection
 * began are not zeros, so they are not drawn. (Growth is unaffected: when a
 * range is clamped, its previous period lies before the data anyway.)
 */
export function resolveRange(f: Pick<Filters, "range" | "from" | "to">, idx: Pick<Index, "anchor" | "dataStart">): Range {
  const end = idx.anchor;
  const clamp = (r: Range): Range => {
    const start = r.start < idx.dataStart ? idx.dataStart : r.start;
    return start > r.end ? { start: r.end, end: r.end } : { start, end: r.end };
  };
  if (f.range === "all") return clamp({ start: idx.dataStart, end });
  if (f.range === "custom") {
    let start = f.from ?? idx.dataStart;
    let stop = f.to ?? end;
    if (start > stop) [start, stop] = [stop, start];
    return clamp({ start, end: stop });
  }
  return clamp({ start: addDays(end, -(PRESET_DAYS[f.range] ?? 90) + 1), end });
}

/** The equal-length period just before `r`. */
export function previousRange(r: Range): Range {
  const len = daysBetween(r.start, r.end) + 1;
  return { start: addDays(r.start, -len), end: addDays(r.start, -1) };
}

export type Gran = "day" | "week" | "month";

/** `auto` granularity: daily up to ~3 months, weekly up to ~13 months, then monthly. */
export function resolveGran(gran: Filters["gran"], r: Range): Gran {
  if (gran !== "auto") return gran;
  const days = daysBetween(r.start, r.end) + 1;
  return days <= 92 ? "day" : days <= 400 ? "week" : "month";
}

export interface Bucket {
  /** The period's natural start (Monday / 1st of month / the day). */
  key: string;
  /** The days it actually covers inside the range. */
  start: string;
  end: string;
  /** True when the range cuts the period short (first or last bucket). */
  partial: boolean;
}

/** Split a range into day, ISO-week (Monday) or month buckets. */
export function makeBuckets(r: Range, gran: Gran): Bucket[] {
  if (gran === "day") return eachDay(r.start, r.end).map((d) => ({ key: d, start: d, end: d, partial: false }));
  const out: Bucket[] = [];
  let key = gran === "week" ? weekStart(r.start) : monthStart(r.start);
  while (key <= r.end) {
    const natEnd = gran === "week" ? addDays(key, 6) : monthEnd(key);
    const start = key < r.start ? r.start : key;
    const end = natEnd > r.end ? r.end : natEnd;
    out.push({ key, start, end, partial: start !== key || end !== natEnd });
    key = addDays(natEnd, 1);
  }
  return out;
}

const SPAN_DAYS: Record<Gran, number> = { day: 1, week: 7, month: 30 };

/**
 * Equal-length buckets counted back from the range end (7-day or 30-day
 * chunks), for sparklines: unlike calendar weeks, the last point is a whole
 * period, so a trend never ends in a fake dip. A leading remainder shorter
 * than one chunk is dropped.
 */
export function trailingBuckets(r: Range, gran: Gran): Bucket[] {
  const len = SPAN_DAYS[gran];
  const out: Bucket[] = [];
  for (let end = r.end; addDays(end, -(len - 1)) >= r.start; end = addDays(end, -len)) {
    const start = addDays(end, -(len - 1));
    out.unshift({ key: start, start, end, partial: false });
  }
  return out;
}

/** Day -> bucket position, for summing daily rows into buckets. */
function dayToBucket(buckets: Bucket[]): Map<string, number> {
  const m = new Map<string, number>();
  buckets.forEach((b, i) => eachDay(b.start, b.end).forEach((d) => m.set(d, i)));
  return m;
}

// ------------------------------------------------------------------- traffic series

/** For each bucket: did the collector see at least one of its days? */
export const bucketCovered = (idx: Pick<Index, "covered">, kind: Kind, buckets: Bucket[]): boolean[] =>
  buckets.map((b) => eachDay(b.start, b.end).some((d) => idx.covered[kind].has(d)));

/** Replace values of never-collected buckets with null (drawn as a gap). */
export const maskUncovered = (values: number[], covered: boolean[]): (number | null)[] =>
  values.map((v, i) => (covered[i] ? v : null));

/** One repo's daily values summed into buckets (zero days filled with 0). */
export function repoSeries(idx: Index, repo: string, kind: Kind, measure: Measure, buckets: Bucket[], pos = dayToBucket(buckets)): number[] {
  const values = new Array<number>(buckets.length).fill(0);
  const days = idx.daily[kind].get(repo);
  if (!days) return values;
  for (const [d, v] of days) {
    const i = pos.get(d);
    if (i !== undefined) values[i] += v[measure];
  }
  return values;
}

/** Sum of one measure over a range for a set of repos. */
export function totalOver(idx: Index, repos: string[], kind: Kind, measure: Measure, r: Range): number {
  let sum = 0;
  for (const repo of repos) {
    const days = idx.daily[kind].get(repo);
    if (!days) continue;
    for (const [d, v] of days) if (d >= r.start && d <= r.end) sum += v[measure];
  }
  return sum;
}

export interface Growth {
  /** Percent change vs the previous equal period, or null when it cannot be stated. */
  pct: number | null;
  /** Why pct is null, or a caveat when it is computed from partial data. */
  note?: string;
  partial?: boolean;
}

/**
 * Growth of `current` over `previous` for the period before `r`. Honest about
 * missing history: no previous data -> no percentage, partial -> flagged.
 */
export function growth(current: number, previous: number, r: Range, dataStart: string): Growth {
  const prev = previousRange(r);
  if (prev.end < dataStart) return { pct: null, note: "no earlier data" };
  if (previous === 0) return current === 0 ? { pct: 0 } : { pct: null, note: "none before" };
  const pct = ((current - previous) / previous) * 100;
  return prev.start < dataStart ? { pct, partial: true, note: "partial previous period" } : { pct };
}

export interface Series {
  key: string;
  label: string;
  values: number[];
  /** True for the folded tail ("Other"), drawn in the de-emphasis grey. */
  other?: boolean;
}

/**
 * Per-repo bucket values grouped for the main chart: by owner (most first, the
 * tail past `MAX_OWNER_SERIES` folded into "Other") or the top `TOP_REPOS`
 * repos plus "Other".
 */
export function groupedSeries(
  idx: Index,
  repos: string[],
  { kind, measure, group, buckets }: { kind: Kind; measure: Measure; group: "owner" | "repo"; buckets: Bucket[] },
): Series[] {
  const pos = dayToBucket(buckets);
  const perRepo = repos.map((repo) => ({ repo, values: repoSeries(idx, repo, kind, measure, buckets, pos) }));
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]);

  let groups: Series[];
  let limit: number;
  if (group === "owner") {
    const byOwner = new Map<string, number[]>();
    for (const { repo, values } of perRepo) {
      const o = idx.repos.get(repo)?.owner ?? repo.split("/")[0];
      byOwner.set(o, add(byOwner.get(o) ?? new Array(buckets.length).fill(0), values));
    }
    groups = [...byOwner].map(([o, values]) => ({ key: o, label: o, values }));
    limit = MAX_OWNER_SERIES;
  } else {
    groups = perRepo.map(({ repo, values }) => ({ key: repo, label: repo, values }));
    limit = TOP_REPOS;
  }
  groups.sort((a, b) => sum(b.values) - sum(a.values) || a.key.localeCompare(b.key));
  // Repos with nothing in range add no band; drop them before folding.
  const nonzero = groups.filter((g) => sum(g.values) > 0);
  if (nonzero.length <= limit) return nonzero;
  const head = nonzero.slice(0, limit);
  const tail = nonzero.slice(limit);
  const other = tail.reduce((acc, g) => add(acc, g.values), new Array<number>(buckets.length).fill(0));
  return [...head, { key: "__other", label: `Other (${tail.length})`, values: other, other: true }];
}

// ------------------------------------------------------------------- stars

/** Index of the last point at or before `date` (binary search), or -1. */
function lastAtOrBefore(points: StarPoint[], date: string): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export type StarField = "stars" | "forks" | "watchers";

/** One repo's value on a day (carried forward), or null when unknown. */
export function starValueAt(idx: Index, repo: string, field: StarField, date: string): number | null {
  const points = idx.stars.get(repo);
  if (!points) return null;
  const i = lastAtOrBefore(points, date);
  return i < 0 ? null : points[i][field];
}

/** Sum over repos of the value at each bucket's end (unknown counts as 0). */
export function starSeries(idx: Index, repos: string[], field: StarField, buckets: Bucket[]): number[] {
  return buckets.map((b) => repos.reduce((s, repo) => s + (starValueAt(idx, repo, field, b.end) ?? 0), 0));
}

export interface StarSummary {
  now: number;
  gained: number;
}

/** Value at the range end, and how much it changed since the day before the range. */
export function starSummary(idx: Index, repos: string[], field: StarField, r: Range): StarSummary {
  let now = 0;
  let before = 0;
  for (const repo of repos) {
    now += starValueAt(idx, repo, field, r.end) ?? 0;
    before += starValueAt(idx, repo, field, addDays(r.start, -1)) ?? 0;
  }
  return { now, gained: now - before };
}

// ------------------------------------------------------------------- 14-day snapshots

export interface WindowSummary {
  count: number;
  uniques: number;
  /** Earliest and latest snapshot dates used (they differ per repo). */
  from: string | null;
  to: string | null;
  repos: number;
}

/** Latest `windows` snapshot per repo at or before `asOf`, summed over repos. */
export function windowSummary(idx: Index, repos: string[], kind: Kind, asOf: string): WindowSummary {
  const out: WindowSummary = { count: 0, uniques: 0, from: null, to: null, repos: 0 };
  for (const repo of repos) {
    const list = idx.windows.get(repo);
    if (!list) continue;
    let best: WindowRow | undefined;
    for (const w of list) if (w.kind === kind && w.fetched <= asOf) best = w; // sorted, so the last match wins
    if (!best) continue;
    out.count += best.count ?? 0;
    out.uniques += best.uniques ?? 0;
    out.repos++;
    if (!out.from || best.fetched < out.from) out.from = best.fetched;
    if (!out.to || best.fetched > out.to) out.to = best.fetched;
  }
  return out;
}

// ------------------------------------------------------------------- referrers & paths

export interface TopItem {
  key: string;
  label: string;
  count: number;
  /** Sum over repos of 14-day uniques (not deduplicated across repos). */
  uniques: number;
  repos: string[];
}

export interface TopResult {
  items: TopItem[];
  /** Earliest / latest snapshot date used. */
  from: string | null;
  to: string | null;
  /** Repos that had a snapshot at or before asOf. */
  repos: number;
}

/**
 * Top items across repos from the LATEST snapshot per repo at or before `asOf`.
 * Each repo contributes exactly one 14-day window, so overlapping weekly
 * snapshots are never summed.
 */
function topFromSnapshots<R extends { repo: string; count: number | null; uniques: number | null }>(
  snaps: Snapshots<R>,
  repos: string[],
  asOf: string,
  keyOf: (r: R) => string,
  labelOf: (r: R) => string,
  n: number,
): TopResult {
  const agg = new Map<string, TopItem>();
  let from: string | null = null;
  let to: string | null = null;
  let used = 0;
  for (const repo of repos) {
    const m = snaps.get(repo);
    if (!m) continue;
    let best = "";
    for (const d of m.keys()) if (d <= asOf && d > best) best = d;
    if (!best) continue;
    used++;
    if (!from || best < from) from = best;
    if (!to || best > to) to = best;
    for (const r of m.get(best)!) {
      const k = keyOf(r);
      const item = agg.get(k) ?? { key: k, label: labelOf(r), count: 0, uniques: 0, repos: [] };
      item.count += r.count ?? 0;
      item.uniques += r.uniques ?? 0;
      item.repos.push(repo);
      agg.set(k, item);
    }
  }
  const items = [...agg.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, n);
  return { items, from, to, repos: used };
}

export const topReferrers = (idx: Index, repos: string[], asOf: string, n = 10): TopResult =>
  topFromSnapshots(idx.referrers, repos, asOf, (r) => r.referrer, (r) => r.referrer, n);

export const topPaths = (idx: Index, repos: string[], asOf: string, n = 10): TopResult =>
  topFromSnapshots(idx.paths, repos, asOf, (r) => r.path, (r) => r.path, n);

/** Snapshot dates available for the selection, newest first (for the "as of" picker). */
export function snapshotDates(idx: Index, repos: string[], upTo: string): string[] {
  const s = new Set<string>();
  for (const repo of repos) for (const d of idx.referrers.get(repo)?.keys() ?? []) if (d <= upTo) s.add(d);
  for (const repo of repos) for (const d of idx.paths.get(repo)?.keys() ?? []) if (d <= upTo) s.add(d);
  return [...s].sort().reverse();
}

// ------------------------------------------------------------------- leaderboard

export interface LeaderRow {
  repo: string;
  info: RepoInfo;
  views: number;
  uniques: number;
  clones: number;
  stars: number | null;
  growth: Growth;
  /** The selected kind+measure per spark bucket. */
  spark: number[];
}

/** Sparkline granularity: enough points to show shape, few enough to read at 80px. */
export const sparkGran = (r: Range): Gran => {
  const days = daysBetween(r.start, r.end) + 1;
  return days <= 31 ? "day" : days <= 400 ? "week" : "month";
};

export function leaderboard(idx: Index, repos: string[], { kind, measure, range }: { kind: Kind; measure: Measure; range: Range }): LeaderRow[] {
  const prev = previousRange(range);
  const sparkBuckets = trailingBuckets(range, sparkGran(range));
  const pos = dayToBucket(sparkBuckets);
  return repos.map((repo) => {
    const one = [repo];
    const cur = totalOver(idx, one, kind, measure, range);
    return {
      repo,
      info: idx.repos.get(repo)!,
      views: totalOver(idx, one, "views", "count", range),
      uniques: totalOver(idx, one, "views", "uniques", range),
      clones: totalOver(idx, one, "clones", "count", range),
      stars: starValueAt(idx, repo, "stars", range.end),
      growth: growth(cur, totalOver(idx, one, kind, measure, prev), range, idx.dataStart),
      spark: repoSeries(idx, repo, kind, measure, sparkBuckets, pos),
    };
  });
}

/** Sort leaderboard rows by a column; nulls last; ties by repo name. */
export function sortRows(rows: LeaderRow[], key: Filters["sort"], desc: boolean): LeaderRow[] {
  const val = (r: LeaderRow): number | string | null =>
    key === "repo" ? r.repo : key === "growth" ? r.growth.pct : key === "stars" ? r.stars : r[key];
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return a.repo.localeCompare(b.repo);
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return (desc ? -c : c) || a.repo.localeCompare(b.repo);
  });
}

// ------------------------------------------------------------------- freshness

export interface Freshness {
  updated: string;
  lastRun: string | null;
  noAccess: number | null;
  noAccessRepos: string[];
  errors: number | null;
}

export function freshness(ds: Dataset): Freshness {
  const runs = [...ds.tables.runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const last = runs[runs.length - 1];
  const lr = ds.lastRun;
  return {
    updated: ds.manifest.updated,
    lastRun: lr?.started_at ?? last?.started_at ?? null,
    noAccess: lr ? lr.no_access.length : (last?.repos_no_access ?? null),
    noAccessRepos: lr?.no_access ?? [],
    errors: lr ? Object.keys(lr.errors).length + Object.keys(lr.owner_errors).length : (last?.errors ?? null),
  };
}
