/**
 * Load a whole data directory from a `DataSource` into one in-memory `Dataset`.
 *
 * Order: `manifest.json` first (it lists every file), then all table files in
 * parallel, then the optional `last_run.json`. The manifest's columns are
 * checked against `TABLE_COLUMNS`; differences become warnings, not failures.
 */
import { parseTable } from "./csv";
import {
  LastRunSchema,
  ManifestSchema,
  checkManifest,
  TABLE_NAMES,
  type LastRun,
  type Manifest,
  type Row,
  type TableName,
} from "./schema";
import { DataSourceError, type DataSource } from "./sources";

export const MANIFEST_FILE = "manifest.json";
export const LAST_RUN_FILE = "last_run.json";

export type Tables = { [T in TableName]: Row<T>[] };

export interface Dataset {
  manifest: Manifest;
  tables: Tables;
  lastRun: LastRun | null;
  /** Schema differences and dropped rows, shown in a banner. */
  warnings: string[];
  /** The source label, for the freshness line. */
  sourceLabel: string;
}

/** Called after each file, so the UI can show determinate progress. */
export type Progress = (done: number, total: number) => void;

export async function loadDataset(source: DataSource, { onProgress }: { onProgress?: Progress } = {}): Promise<Dataset> {
  const manifestText = await source.getText(MANIFEST_FILE);
  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestText));
  } catch (e) {
    throw new DataSourceError(
      "http",
      `${MANIFEST_FILE} is not a ghtraffic manifest (${(e as Error).message.slice(0, 200)}).`,
      undefined,
      MANIFEST_FILE,
    );
  }
  const warnings = checkManifest(manifest);

  const jobs = TABLE_NAMES.flatMap((t) => (manifest.tables[t]?.files ?? []).map((file) => ({ table: t, file })));
  const total = jobs.length + 1;
  let done = 0;
  onProgress?.(done, total);

  const tables = Object.fromEntries(TABLE_NAMES.map((t) => [t, []])) as unknown as Tables;
  const results = await Promise.all(
    jobs.map(async ({ table, file }) => {
      const text = await source.getText(file);
      onProgress?.(++done, total);
      return { table, parsed: parseTable(table, text, { source: file }) };
    }),
  );
  for (const { table, parsed } of results) {
    (tables[table] as unknown[]).push(...parsed.rows);
    if (parsed.dropped) warnings.push(`${parsed.dropped} invalid row(s) skipped. ${parsed.problems.join(" ")}`);
  }

  const lastRun = await loadLastRun(source, warnings);
  onProgress?.(total, total);
  return { manifest, tables, lastRun, warnings, sourceLabel: source.label };
}

/** `last_run.json` is optional: a 404 means "not there", anything else is a warning. */
async function loadLastRun(source: DataSource, warnings: string[]): Promise<LastRun | null> {
  try {
    const text = await source.getText(LAST_RUN_FILE);
    // A dev server with an SPA fallback answers a missing file with index.html.
    if (text.trimStart().startsWith("<")) return null;
    const res = LastRunSchema.safeParse(JSON.parse(text));
    if (res.success) return res.data;
    warnings.push(`${LAST_RUN_FILE} has an unexpected shape; ignored.`);
  } catch (e) {
    if (!(e instanceof DataSourceError && e.kind === "not-found")) {
      warnings.push(`${LAST_RUN_FILE} could not be read; ignored.`);
    }
  }
  return null;
}
