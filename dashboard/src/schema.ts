/**
 * The data contract of a ghtraffic data directory, as the dashboard sees it.
 *
 * `TABLE_COLUMNS` mirrors `ghtraffic.tables.TABLES` (the Python single source of
 * truth). A Python test parses the object literal below as JSON and compares it
 * with `TABLES`, so keep it JSON-compatible: double-quoted keys and strings, no
 * trailing commas, no comments inside the braces.
 *
 * Everything else here (row types, Zod validators, the manifest check) is
 * DERIVED from `TABLE_COLUMNS` plus `COLUMN_KINDS`, so adding a column means
 * editing one line in each place, never a hand-written type.
 */
// zod/mini: the same validators as "zod", as tree-shakable functions (a much
// smaller bundle). Chaining becomes wrapping: z.optional(x), x.check(...).
import * as z from "zod/mini";

// prettier-ignore
export const TABLE_COLUMNS = {
  "views": ["date", "repo", "count", "uniques"],
  "clones": ["date", "repo", "count", "uniques"],
  "windows": ["fetched", "repo", "kind", "count", "uniques"],
  "referrers": ["fetched", "repo", "referrer", "count", "uniques"],
  "paths": ["fetched", "repo", "path", "title", "count", "uniques"],
  "stars": ["date", "repo", "stars", "forks", "watchers"],
  "repos": ["repo", "owner", "private", "fork", "archived", "can_push", "language", "created_at", "pushed_at", "description", "last_seen"],
  "runs": ["started_at", "duration_s", "repos_listed", "repos_collected", "repos_no_access", "snapshots", "errors"]
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as TableName[];

/** Every column name that appears in any table. */
type ColumnName = (typeof TABLE_COLUMNS)[TableName][number];

/**
 * How a CSV cell becomes a JS value. Keyed by column name (a column means the
 * same thing in every table it appears in).
 *
 * - `int`: integer; an empty cell becomes `null` (stars backfill leaves forks
 *   and watchers empty, and "unknown" must not be confused with 0).
 * - `num`: any number (seconds); empty -> null.
 * - `bool`: "true" / "false" (Python writes lowercase); anything else -> false.
 * - `date`: an ISO date `YYYY-MM-DD` (day precision is all the tables use).
 * - `str`: kept as text.
 */
type Kind = "int" | "num" | "bool" | "date" | "str";

export const COLUMN_KINDS = {
  date: "date",
  fetched: "date",
  last_seen: "str",
  repo: "str",
  owner: "str",
  kind: "str",
  referrer: "str",
  path: "str",
  title: "str",
  language: "str",
  description: "str",
  created_at: "str",
  pushed_at: "str",
  started_at: "str",
  count: "int",
  uniques: "int",
  stars: "int",
  forks: "int",
  watchers: "int",
  repos_listed: "int",
  repos_collected: "int",
  repos_no_access: "int",
  snapshots: "int",
  errors: "int",
  duration_s: "num",
  private: "bool",
  fork: "bool",
  archived: "bool",
  can_push: "bool",
} as const satisfies Record<ColumnName, Kind>;

// ------------------------------------------------------------ cell validators

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Zod validator for one cell of a given kind (input is always CSV text). */
const toNumber = z.pipe(
  z.string(),
  z.transform((s: string) => (s.trim() === "" ? null : Number(s))),
);
const CELL: Record<Kind, z.ZodMiniType> = {
  int: toNumber.check(z.refine((n) => n === null || Number.isInteger(n), "not an integer")),
  num: toNumber.check(z.refine((n) => n === null || Number.isFinite(n), "not a number")),
  bool: z.pipe(z.string(), z.transform((s: string) => s.trim().toLowerCase() === "true")),
  // Keep only the day: `fetched` / `date` are days, but tolerate a timestamp.
  date: z
    .pipe(z.string(), z.transform((s: string) => s.trim().slice(0, 10)))
    .check(z.refine((s) => ISO_DATE.test(s), "not an ISO date")),
  str: z.string(),
};

/** The JS type each kind parses to. */
type KindType = {
  int: number | null;
  num: number | null;
  bool: boolean;
  date: string;
  str: string;
};

/** A parsed row of table `T`, derived from the column lists (no hand-written types). */
export type Row<T extends TableName> = {
  [C in (typeof TABLE_COLUMNS)[T][number]]: KindType[(typeof COLUMN_KINDS)[C]];
};

export type DailyRow = Row<"views">;
export type WindowRow = Row<"windows">;
export type ReferrerRow = Row<"referrers">;
export type PathRow = Row<"paths">;
export type StarRow = Row<"stars">;
export type RepoRow = Row<"repos">;
export type RunRow = Row<"runs">;

/** Build the Zod object schema of one table from its column list. */
function rowSchemaFor(table: TableName) {
  const shape: Record<string, z.ZodMiniType> = {};
  for (const col of TABLE_COLUMNS[table]) {
    // A column missing from the file arrives as "" (see csv.ts), so every cell
    // validator accepts a string.
    shape[col] = CELL[COLUMN_KINDS[col as ColumnName]];
  }
  return z.object(shape);
}

/** One Zod row schema per table, derived from `TABLE_COLUMNS`. */
// (The cast states what rowSchemaFor builds; TS cannot follow the mapped shape.)
export const ROW_SCHEMAS = Object.fromEntries(
  TABLE_NAMES.map((t) => [t, rowSchemaFor(t)]),
) as unknown as { [T in TableName]: z.ZodMiniType<Row<T>, Record<string, string>> };

// ------------------------------------------------------------ manifest

export const ManifestSchema = z.object({
  schema_version: z.int(),
  updated: z.string(),
  tables: z.record(
    z.string(),
    z.object({
      files: z.array(z.string()),
      columns: z.array(z.string()),
      key: z.optional(z.array(z.string())),
      description: z.optional(z.string()),
    }),
  ),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** The schema version this dashboard was written against. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Differences between the manifest's declared columns and `TABLE_COLUMNS`, as
 * human sentences (empty when they agree). The dashboard still loads what it
 * can and shows these in a banner.
 */
export function checkManifest(manifest: Manifest): string[] {
  const out: string[] = [];
  if (manifest.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    out.push(
      `Data schema version is ${manifest.schema_version}; this dashboard expects ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  for (const t of TABLE_NAMES) {
    const declared = manifest.tables[t];
    if (!declared) {
      out.push(`Table "${t}" is missing from the manifest.`);
      continue;
    }
    const expected: readonly string[] = TABLE_COLUMNS[t];
    const missing = expected.filter((c) => !declared.columns.includes(c));
    const extra = declared.columns.filter((c) => !expected.includes(c));
    if (missing.length) out.push(`Table "${t}" lacks column(s): ${missing.join(", ")}.`);
    if (extra.length) out.push(`Table "${t}" has unexpected column(s): ${extra.join(", ")}.`);
  }
  for (const t of Object.keys(manifest.tables)) {
    if (!(t in TABLE_COLUMNS)) out.push(`Table "${t}" is not known to this dashboard (ignored).`);
  }
  return out;
}

// ------------------------------------------------------------ last_run.json

/** `last_run.json` (optional). Only the fields the dashboard reads are required. */
export const LastRunSchema = z.looseObject({
  started_at: z.string(),
  duration_s: z.optional(z.number()),
  repos_listed: z.optional(z.number()),
  repos_collected: z.optional(z.number()),
  no_access: z._default(z.array(z.string()), []),
  errors: z._default(z.record(z.string(), z.string()), {}),
  owner_errors: z._default(z.record(z.string(), z.string()), {}),
});
export type LastRun = z.infer<typeof LastRunSchema>;
