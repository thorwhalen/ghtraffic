/** A small in-memory data directory for tests, shaped like ghtraffic's output. */
import { TABLE_COLUMNS } from "../src/schema";
import type { DataSource } from "../src/sources";
import { DataSourceError } from "../src/sources";

const csv = (header: readonly string[], rows: (string | number)[][]) =>
  [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";

export const FILES: Record<string, string> = {
  "views/2026.csv": csv(TABLE_COLUMNS.views, [
    ["2026-03-02", "a/one", 10, 4],
    ["2026-03-03", "a/one", 5, 2],
    ["2026-03-09", "a/one", 7, 3],
    ["2026-03-02", "b/two", 1, 1],
  ]),
  "clones/2026.csv": csv(TABLE_COLUMNS.clones, [["2026-03-03", "a/one", 2, 1]]),
  "windows/2026.csv": csv(TABLE_COLUMNS.windows, [
    ["2026-03-01", "a/one", "views", 40, 9],
    ["2026-03-08", "a/one", "views", 30, 7],
    ["2026-03-08", "b/two", "views", 3, 2],
  ]),
  "referrers/2026.csv": csv(TABLE_COLUMNS.referrers, [
    ["2026-03-01", "a/one", "google.com", 100, 50],
    ["2026-03-08", "a/one", "google.com", 80, 40],
    ["2026-03-08", "a/one", "t.co", 5, 3],
    ["2026-03-08", "b/two", "google.com", 4, 2],
  ]),
  "paths/2026.csv": csv(TABLE_COLUMNS.paths, [["2026-03-08", "a/one", "/a/one", '"a/one, the repo"', 20, 10]]),
  "stars.csv": csv(TABLE_COLUMNS.stars, [
    ["2026-01-01", "a/one", 1, "", ""],
    ["2026-03-01", "a/one", 3, 1, 2],
    ["2026-03-05", "a/one", 4, "", ""],
    ["2026-03-04", "b/two", 2, 0, 1],
  ]),
  "repos.csv": csv(TABLE_COLUMNS.repos, [
    ["a/one", "a", "false", "false", "false", "true", "Python", "", "", '"A repo, with a comma"', "2026-03-10"],
    ["b/two", "b", "true", "false", "true", "true", "", "", "", "", "2026-03-10"],
  ]),
  "runs.csv": csv(TABLE_COLUMNS.runs, [["2026-03-10T03:00:00+00:00", 1.5, 2, 2, 0, 2, 0]]),
};

export const MANIFEST = {
  schema_version: 1,
  updated: "2026-03-10",
  tables: Object.fromEntries(
    Object.entries(TABLE_COLUMNS).map(([t, columns]) => [
      t,
      { files: Object.keys(FILES).filter((f) => f === `${t}.csv` || f.startsWith(`${t}/`)), columns: [...columns], key: [] },
    ]),
  ),
};

/** A DataSource over a dict of files (404 for anything missing). */
export function memorySource(files: Record<string, string>, label = "memory"): DataSource {
  return {
    label,
    async getText(path) {
      if (!(path in files)) throw new DataSourceError("not-found", `${path} not found`, 404, path);
      return files[path];
    },
  };
}

export const fullFiles = (manifest: object = MANIFEST): Record<string, string> => ({ ...FILES, "manifest.json": JSON.stringify(manifest) });
