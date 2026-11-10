import { beforeAll, describe, expect, it } from "vitest";
import {
  bucketCovered,
  maskUncovered,
  buildIndex,
  carryForwardStars,
  groupedSeries,
  growth,
  leaderboard,
  makeBuckets,
  previousRange,
  repoSeries,
  resolveGran,
  resolveRange,
  selectRepos,
  sortRows,
  starSeries,
  starSummary,
  topReferrers,
  totalOver,
  trailingBuckets,
  windowSummary,
  type Index,
} from "../src/aggregate";
import { assignSlots } from "../src/colors";
import { addDays, weekStart } from "../src/dates";
import { DEFAULT_FILTERS } from "../src/filters";
import { loadDataset } from "../src/load";
import { fullFiles, memorySource } from "./fixtures";

let idx: Index;
beforeAll(async () => {
  idx = buildIndex(await loadDataset(memorySource(fullFiles())));
});

describe("dates", () => {
  it("weeks start on Monday", () => {
    expect(weekStart("2026-03-04")).toBe("2026-03-02"); // Wednesday -> Monday
    expect(weekStart("2026-03-08")).toBe("2026-03-02"); // Sunday -> previous Monday
    expect(weekStart("2026-03-09")).toBe("2026-03-09");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("bucketing", () => {
  it("makes ISO-week buckets, flagging the ones the range cuts short", () => {
    const b = makeBuckets({ start: "2026-03-04", end: "2026-03-16" }, "week");
    expect(b.map((x) => [x.key, x.start, x.end, x.partial])).toEqual([
      ["2026-03-02", "2026-03-04", "2026-03-08", true],
      ["2026-03-09", "2026-03-09", "2026-03-15", false],
      ["2026-03-16", "2026-03-16", "2026-03-16", true],
    ]);
  });
  it("makes month buckets across a year boundary, with month lengths right", () => {
    const b = makeBuckets({ start: "2025-12-15", end: "2026-02-28" }, "month");
    expect(b.map((x) => [x.key, x.end, x.partial])).toEqual([
      ["2025-12-01", "2025-12-31", true],
      ["2026-01-01", "2026-01-31", false],
      ["2026-02-01", "2026-02-28", false],
    ]);
  });
  it("sums daily rows into buckets and fills absent (zero) days", () => {
    const days = makeBuckets({ start: "2026-03-01", end: "2026-03-04" }, "day");
    expect(repoSeries(idx, "a/one", "views", "count", days)).toEqual([0, 10, 5, 0]);
    const weeks = makeBuckets({ start: "2026-03-02", end: "2026-03-15" }, "week");
    expect(repoSeries(idx, "a/one", "views", "count", weeks)).toEqual([15, 7]);
    expect(repoSeries(idx, "a/one", "views", "uniques", weeks)).toEqual([6, 3]);
  });
  it("counts sparkline buckets back from the range end, dropping a short remainder", () => {
    const b = trailingBuckets({ start: "2026-03-01", end: "2026-03-16" }, "week");
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ["2026-03-03", "2026-03-09"],
      ["2026-03-10", "2026-03-16"],
    ]);
  });
  it("auto granularity picks day, week, then month", () => {
    expect(resolveGran("auto", { start: "2026-01-01", end: "2026-03-01" })).toBe("day");
    expect(resolveGran("auto", { start: "2025-03-01", end: "2026-03-01" })).toBe("week");
    expect(resolveGran("auto", { start: "2024-01-01", end: "2026-03-01" })).toBe("month");
    expect(resolveGran("month", { start: "2026-03-01", end: "2026-03-02" })).toBe("month");
  });
});

describe("ranges and growth", () => {
  it("ends presets at the anchor day and builds an equal previous period", () => {
    expect(idx.anchor).toBe("2026-03-10");
    const r = resolveRange({ ...DEFAULT_FILTERS, range: "7d" }, idx);
    expect(r).toEqual({ start: "2026-03-04", end: "2026-03-10" });
    expect(previousRange(r)).toEqual({ start: "2026-02-25", end: "2026-03-03" });
    expect(resolveRange({ ...DEFAULT_FILTERS, range: "custom", from: "2026-03-09", to: "2026-03-02" }, idx)).toEqual({
      start: "2026-03-02",
      end: "2026-03-09",
    });
  });
  it("clamps every range start to the first day with data", () => {
    expect(idx.dataStart).toBe("2026-03-02");
    for (const range of ["all", "90d", "1y"] as const) {
      expect(resolveRange({ ...DEFAULT_FILTERS, range }, idx)).toEqual({ start: "2026-03-02", end: "2026-03-10" });
    }
    expect(resolveRange({ ...DEFAULT_FILTERS, range: "custom", from: "2025-01-01", to: "2026-03-05" }, idx)).toEqual({
      start: "2026-03-02",
      end: "2026-03-05",
    });
  });
  it("marks never-collected buckets as gaps, not zeros", () => {
    // The fixture's one run (Mar 10) covers Feb 24 - Mar 10; data rows cover Mar 2 - Mar 9.
    expect(idx.covered.views.has("2026-02-24")).toBe(true);
    expect(idx.covered.views.has("2026-02-23")).toBe(false);
    const weeks = makeBuckets({ start: "2026-02-09", end: "2026-03-08" }, "week");
    const covered = bucketCovered(idx, "views", weeks);
    expect(covered).toEqual([false, false, true, true]);
    expect(maskUncovered([1, 2, 3, 4], covered)).toEqual([null, null, 3, 4]);
  });
  it("computes growth %, and refuses to invent it", () => {
    const r = { start: "2026-03-08", end: "2026-03-14" };
    expect(growth(150, 100, r, "2026-01-01")).toEqual({ pct: 50 });
    expect(growth(5, 0, r, "2026-01-01").pct).toBeNull(); // nothing before: no percentage
    expect(growth(0, 0, r, "2026-01-01")).toEqual({ pct: 0 });
    expect(growth(5, 3, r, "2026-03-10").pct).toBeNull(); // previous period predates the data
    expect(growth(6, 3, r, "2026-03-03")).toMatchObject({ pct: 100, partial: true });
  });
  it("totals a range across repos", () => {
    const r = { start: "2026-03-02", end: "2026-03-03" };
    expect(totalOver(idx, ["a/one", "b/two"], "views", "count", r)).toBe(16);
  });
});

describe("stars carry-forward", () => {
  it("fills empty forks/watchers with the last known value, unknown before", () => {
    const pts = carryForwardStars([
      { date: "2026-03-05", repo: "r", stars: 4, forks: null, watchers: null },
      { date: "2026-01-01", repo: "r", stars: 1, forks: null, watchers: null },
      { date: "2026-03-01", repo: "r", stars: 3, forks: 1, watchers: 2 },
    ]).get("r")!;
    expect(pts.map((p) => [p.date, p.stars, p.forks, p.watchers])).toEqual([
      ["2026-01-01", 1, null, null],
      ["2026-03-01", 3, 1, 2],
      ["2026-03-05", 4, 1, 2],
    ]);
  });
  it("reads values at bucket ends and gains over a range", () => {
    const b = makeBuckets({ start: "2026-03-01", end: "2026-03-06" }, "day");
    expect(starSeries(idx, ["a/one", "b/two"], "stars", b)).toEqual([3, 3, 3, 5, 6, 6]);
    expect(starSeries(idx, ["a/one"], "forks", b)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(starSummary(idx, ["a/one", "b/two"], "stars", { start: "2026-03-02", end: "2026-03-10" })).toEqual({ now: 6, gained: 3 });
  });
});

describe("selection and grouping", () => {
  it("applies owner, visibility and repo filters", () => {
    expect(selectRepos(idx, DEFAULT_FILTERS)).toEqual(["a/one", "b/two"]);
    expect(selectRepos(idx, { ...DEFAULT_FILTERS, priv: false })).toEqual(["a/one"]);
    expect(selectRepos(idx, { ...DEFAULT_FILTERS, archived: false })).toEqual(["a/one"]);
    expect(selectRepos(idx, { ...DEFAULT_FILTERS, owners: ["b"] })).toEqual(["b/two"]);
    expect(selectRepos(idx, { ...DEFAULT_FILTERS, owners: ["b"], repos: ["a/one"] })).toEqual([]);
  });
  it("groups by owner and folds repos past the top N into Other", () => {
    const buckets = makeBuckets({ start: "2026-03-02", end: "2026-03-08" }, "week");
    const byOwner = groupedSeries(idx, ["a/one", "b/two"], { kind: "views", measure: "count", group: "owner", buckets });
    expect(byOwner.map((s) => [s.key, s.values])).toEqual([
      ["a", [15]],
      ["b", [1]],
    ]);
  });
  it("keeps an entity's colour when the selection changes", () => {
    const rank = new Map([
      ["x", 0],
      ["y", 1],
      ["z", 2],
    ]);
    expect(assignSlots(["x", "y", "z"], rank).get("z")).toBe(2);
    expect(assignSlots(["z"], rank).get("z")).toBe(2); // filtered: z is not repainted
    expect(assignSlots(["new", "y"], rank)).toEqual(new Map([["y", 1], ["new", 0]]));
  });
});

describe("snapshots", () => {
  it("uses only the latest snapshot per repo at or before asOf (no double counting)", () => {
    const t = topReferrers(idx, ["a/one", "b/two"], "2026-03-10");
    expect(t.items.map((i) => [i.key, i.count])).toEqual([
      ["google.com", 84],
      ["t.co", 5],
    ]);
    expect([t.from, t.to, t.repos]).toEqual(["2026-03-08", "2026-03-08", 2]);
    const earlier = topReferrers(idx, ["a/one", "b/two"], "2026-03-07");
    expect(earlier.items).toEqual([{ key: "google.com", label: "google.com", count: 100, uniques: 50, repos: ["a/one"] }]);
  });
  it("sums 14-day window snapshots across repos, latest per repo", () => {
    expect(windowSummary(idx, ["a/one", "b/two"], "views", "2026-03-10")).toEqual({ count: 33, uniques: 9, from: "2026-03-08", to: "2026-03-08", repos: 2 });
  });
});

describe("leaderboard", () => {
  it("builds rows and sorts with nulls last", () => {
    const rows = leaderboard(idx, ["a/one", "b/two"], { kind: "views", measure: "count", range: { start: "2026-03-02", end: "2026-03-10" } });
    const a = rows.find((r) => r.repo === "a/one")!;
    expect([a.views, a.uniques, a.clones, a.stars]).toEqual([22, 9, 2, 4]);
    expect(sortRows(rows, "views", true).map((r) => r.repo)).toEqual(["a/one", "b/two"]);
    expect(sortRows(rows, "repo", true).map((r) => r.repo)).toEqual(["b/two", "a/one"]);
    expect(sortRows(rows, "growth", true).every((r) => r.growth.pct === null)).toBe(true);
  });
});
