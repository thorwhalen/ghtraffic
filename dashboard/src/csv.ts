/**
 * CSV text -> validated rows.
 *
 * A tiny RFC 4180 parser (quoted fields, doubled quotes, commas and newlines
 * inside quotes, CRLF or LF) — enough for what Python's `csv` module writes, and
 * a few hundred bytes instead of a dependency. Rows are then validated with the
 * table's Zod schema from `schema.ts`.
 */
import { ROW_SCHEMAS, TABLE_COLUMNS, type Row, type TableName } from "./schema";

/** Split CSV text into records of raw string cells. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // Skip a UTF-8 byte-order mark if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A blank line (one empty field) is not a record.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** Records with a header row -> objects keyed by header. Missing cells become "". */
export function recordsToObjects(records: string[][]): Record<string, string>[] {
  if (records.length === 0) return [];
  const [header, ...body] = records;
  return body.map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, j) => (obj[h] = cells[j] ?? ""));
    return obj;
  });
}

export interface ParsedTable<T extends TableName> {
  rows: Row<T>[];
  /** Human-readable notes on rows that failed validation (first few only). */
  problems: string[];
  /** How many rows were dropped because they did not validate. */
  dropped: number;
}

/**
 * Parse one table file. Invalid rows are dropped and reported, never thrown:
 * one bad line in a year of data should not blank the dashboard.
 */
export function parseTable<T extends TableName>(
  table: T,
  text: string,
  { source = table as string, maxProblems = 3 } = {},
): ParsedTable<T> {
  const schema = ROW_SCHEMAS[table];
  const objects = recordsToObjects(parseCsvRecords(text));
  const rows: Row<T>[] = [];
  const problems: string[] = [];
  let dropped = 0;
  objects.forEach((obj, idx) => {
    // Only the columns we know; unknown extra columns are ignored.
    const cells: Record<string, string> = {};
    for (const c of TABLE_COLUMNS[table]) cells[c] = obj[c] ?? "";
    const res = schema.safeParse(cells);
    if (res.success) rows.push(res.data);
    else {
      dropped++;
      if (problems.length < maxProblems) {
        const issue = res.error.issues[0];
        problems.push(`${source} line ${idx + 2}: ${issue.path.join(".")} ${issue.message}`);
      }
    }
  });
  return { rows, problems, dropped };
}
