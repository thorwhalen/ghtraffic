// `?raw` (a Vite import) gives the file's text: the same bytes the Python test reads.
import schemaSource from "../src/schema.ts?raw";
import { describe, expect, it } from "vitest";
import { parseCsvRecords, parseTable } from "../src/csv";
import { checkManifest, TABLE_COLUMNS, type Manifest } from "../src/schema";
import { MANIFEST } from "./fixtures";

describe("parseCsvRecords", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text = '\ufeffa,b\r\n"x, y","say ""hi"""\r\n"multi\nline",2\n\n';
    expect(parseCsvRecords(text)).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "2"],
    ]);
  });
  it("keeps a last line without a newline", () => {
    expect(parseCsvRecords("a\n1")).toEqual([["a"], ["1"]]);
  });
});

describe("parseTable", () => {
  it("coerces ints, keeps empty ints as null, and reads booleans", () => {
    const stars = parseTable("stars", "date,repo,stars,forks,watchers\n2026-01-01,a/b,3,,\n");
    expect(stars.rows).toEqual([{ date: "2026-01-01", repo: "a/b", stars: 3, forks: null, watchers: null }]);
    const repos = parseTable("repos", "repo,owner,private,fork,archived\na/b,a,true,false,False\n");
    expect(repos.rows[0]).toMatchObject({ private: true, fork: false, archived: false, language: "" });
  });
  it("drops and reports invalid rows instead of failing", () => {
    const res = parseTable("views", "date,repo,count,uniques\nnot-a-date,a/b,1,1\n2026-01-02,a/b,x,1\n2026-01-03,a/b,2,1\n");
    expect(res.rows).toHaveLength(1);
    expect(res.dropped).toBe(2);
    expect(res.problems[0]).toMatch(/line 2/);
  });
});

describe("TABLE_COLUMNS", () => {
  it("is written as a JSON object literal (the Python test parses it)", () => {
    const m = schemaSource.match(/export const TABLE_COLUMNS = (\{[\s\S]*?\}) as const;/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(TABLE_COLUMNS);
  });
});

describe("checkManifest", () => {
  it("is silent when the manifest matches", () => {
    expect(checkManifest(MANIFEST as Manifest)).toEqual([]);
  });
  it("names missing, extra and unknown columns and tables", () => {
    const m = structuredClone(MANIFEST) as Manifest;
    m.tables.views.columns = ["date", "repo", "count", "extra"];
    delete m.tables.runs;
    m.tables.issues = { files: [], columns: [] };
    m.schema_version = 2;
    const notes = checkManifest(m).join("\n");
    expect(notes).toMatch(/version is 2/);
    expect(notes).toMatch(/"views" lacks column\(s\): uniques/);
    expect(notes).toMatch(/"views" has unexpected column\(s\): extra/);
    expect(notes).toMatch(/"runs" is missing/);
    expect(notes).toMatch(/"issues" is not known/);
  });
});
