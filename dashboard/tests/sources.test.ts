import { describe, expect, it, vi } from "vitest";
import { loadDataset } from "../src/load";
import { resolveSource } from "../src/resolveSource";
import { formatHash, parseHash } from "../src/route";
import { DEFAULT_FILTERS } from "../src/filters";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, toStored, type Settings } from "../src/settings";
import { DataSourceError, githubContentsUrl, githubSource, urlSource, type Fetch } from "../src/sources";
import type { DataProvider } from "@zodal/store";
import { fullFiles, MANIFEST, memorySource } from "./fixtures";

/** A fetch mock answering from a dict keyed by URL; records every call. */
function mockFetch(answer: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init)) as unknown as Fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

describe("urlSource", () => {
  it("joins the base and path, sends no credentials", async () => {
    const f = mockFetch(() => new Response("hello"));
    const src = urlSource("https://example.org/data", { fetchFn: f });
    expect(await src.getText("views/2026.csv")).toBe("hello");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://example.org/data/views/2026.csv");
    expect(init.credentials).toBe("omit");
  });
  it("maps 404 to a not-found error", async () => {
    const src = urlSource("/demo/", { fetchFn: mockFetch(() => new Response("", { status: 404 })) });
    await expect(src.getText("manifest.json")).rejects.toMatchObject({ kind: "not-found", status: 404 });
  });
  it("maps a network failure to a network error", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as Fetch;
    await expect(urlSource("/x/", { fetchFn: f }).getText("a")).rejects.toMatchObject({ kind: "network" });
  });
});

describe("githubSource", () => {
  const coords = { repo: "me/traffic-data", branch: "main", path: "data", token: "github_pat_SECRET" };

  it("calls only api.github.com, with the token in the header and never in the URL", async () => {
    const f = mockFetch(() => new Response("{}"));
    await githubSource(coords, { fetchFn: f }).getText("views/2026.csv");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/me/traffic-data/contents/data/views/2026.csv?ref=main");
    expect(url).not.toContain("SECRET");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer github_pat_SECRET");
    expect(h.Accept).toBe("application/vnd.github.raw+json");
    expect(init.credentials).toBe("omit");
  });
  it("encodes path segments and refuses path tricks", () => {
    expect(githubContentsUrl({ repo: "a/b", path: "../x y" }, "manifest.json")).toBe(
      "https://api.github.com/repos/a/b/contents/x%20y/manifest.json?ref=main",
    );
  });
  it("rejects a malformed repo before any request", () => {
    expect(() => githubSource({ repo: "evil.com/x/y", token: "t" })).toThrow(DataSourceError);
    expect(() => githubSource({ repo: "../../user", token: "t" })).toThrow(/owner\/name/);
  });
  it.each([
    [401, "unauthorized", /rejected the token/],
    [403, "forbidden", /Contents: read/],
    [404, "not-found", /not found in me\/traffic-data@main:data/],
    [500, "http", /answered 500/],
  ])("explains HTTP %i", async (status, kind, msg) => {
    const src = githubSource(coords, { fetchFn: mockFetch(() => new Response("", { status })) });
    const err = (await src.getText("manifest.json").catch((e) => e)) as DataSourceError;
    expect(err.kind).toBe(kind);
    expect(err.message).toMatch(msg);
  });
  it("recognises an exhausted rate limit", async () => {
    const f = mockFetch(() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } }));
    await expect(githubSource(coords, { fetchFn: f }).getText("a")).rejects.toMatchObject({ kind: "rate-limited" });
  });
  it("loads a whole dataset through the mocked API", async () => {
    const files = fullFiles();
    const f = mockFetch((url) => {
      const path = decodeURIComponent(new URL(url).pathname.replace("/repos/me/traffic-data/contents/data/", ""));
      return path in files ? new Response(files[path]) : new Response("", { status: 404 });
    });
    const ds = await loadDataset(githubSource(coords, { fetchFn: f }));
    expect(ds.tables.views).toHaveLength(4);
    expect(ds.lastRun).toBeNull(); // last_run.json absent -> 404 -> fine, no warning
    expect(ds.warnings).toEqual([]);
    expect(f.mock.calls.every(([u]) => u.startsWith("https://api.github.com/"))).toBe(true);
  });
});

describe("loadDataset", () => {
  it("reads every file listed by the manifest, plus last_run.json", async () => {
    const files = { ...fullFiles(), "last_run.json": JSON.stringify({ started_at: "2026-03-10T03:00:00+00:00", no_access: ["x/y"] }) };
    const progress: [number, number][] = [];
    const ds = await loadDataset(memorySource(files), { onProgress: (d, t) => progress.push([d, t]) });
    expect(ds.tables.repos.map((r) => r.repo)).toEqual(["a/one", "b/two"]);
    expect(ds.tables.repos[0].description).toBe("A repo, with a comma");
    expect(ds.lastRun?.no_access).toEqual(["x/y"]);
    const total = Object.values(MANIFEST.tables).reduce((n, t) => n + t.files.length, 0) + 1;
    expect(progress[0]).toEqual([0, total]);
    expect(progress.at(-1)).toEqual([total, total]);
  });
  it("warns, without failing, when the manifest's columns differ", async () => {
    const m = structuredClone(MANIFEST);
    m.tables.views.columns = ["date", "repo", "count"];
    const ds = await loadDataset(memorySource(fullFiles(m)));
    expect(ds.warnings.join(" ")).toMatch(/views.*uniques/);
    expect(ds.tables.views.length).toBe(4);
  });
  it("fails clearly when the manifest is missing or not a manifest", async () => {
    await expect(loadDataset(memorySource({}))).rejects.toMatchObject({ kind: "not-found" });
    await expect(loadDataset(memorySource({ "manifest.json": "<html>" }))).rejects.toThrow(/not a ghtraffic manifest/);
  });
});

describe("resolveSource", () => {
  const base = { dataRepo: null, dataUrl: null, settings: DEFAULT_SETTINGS, demoUrl: "/ghtraffic/demo/" };
  it("defaults to the demo", () => {
    expect(resolveSource(base)).toEqual({ kind: "url", url: "/ghtraffic/demo/", demo: true });
  });
  it("prefers the hash repo, then ?data=, then saved settings", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, source: "github", ghRepo: "me/saved" };
    expect(resolveSource({ ...base, settings, dataUrl: "https://x/", dataRepo: { repo: "me/hash" } })).toMatchObject({ kind: "github", repo: "me/hash" });
    expect(resolveSource({ ...base, settings, dataUrl: "https://x/" })).toMatchObject({ kind: "url", url: "https://x/" });
    expect(resolveSource({ ...base, settings })).toMatchObject({ kind: "github", repo: "me/saved", branch: "main", fromHash: false });
  });
});

describe("route (URL hash)", () => {
  it("round-trips filters and the data repo, omitting defaults", () => {
    const route = {
      filters: { ...DEFAULT_FILTERS, range: "30d" as const, owners: ["a", "b"], priv: false, detail: "a/one" },
      dataRepo: { repo: "me/data", branch: "main", path: "x" },
    };
    const hash = formatHash(route);
    expect(hash).toBe("detail=a/one&owners=a,b&path=x&priv=0&range=30d&repo=me/data");
    expect(parseHash("#" + hash)).toEqual({ ...route, dataRepo: { repo: "me/data", branch: undefined, path: "x" } });
    expect(formatHash({ filters: DEFAULT_FILTERS, dataRepo: null })).toBe("");
  });
  it("falls back to defaults for bad values", () => {
    expect(parseHash("#range=forever&kind=stars&asof=yesterday").filters).toEqual(DEFAULT_FILTERS);
  });
});

describe("settings (zodal store)", () => {
  /** An in-memory DataProvider: the same interface as the localStorage one. */
  function memoryProvider(): DataProvider<Settings> & { items: Map<string, Settings> } {
    const items = new Map<string, Settings>();
    return {
      items,
      getList: async () => ({ data: [...items.values()], total: items.size }),
      getOne: async (id: string) => {
        const v = items.get(id);
        if (!v) throw new Error("not found");
        return v;
      },
      create: async (d: Settings) => (items.set(d.id!, d as Settings), d as Settings),
      update: async (id: string, d: Partial<Settings>) => (items.set(id, { ...items.get(id)!, ...d }), items.get(id)!),
      delete: async (id: string) => void items.delete(id),
      upsert: async (d: Settings) => (items.set(d.id, d), d),
    } as unknown as DataProvider<Settings> & { items: Map<string, Settings> };
  }
  it("stores the token only when asked to remember it", async () => {
    const p = memoryProvider();
    await saveSettings(p, { ...DEFAULT_SETTINGS, token: "t1", rememberToken: false });
    expect(p.items.get("settings")!.token).toBe("");
    await saveSettings(p, { ...DEFAULT_SETTINGS, token: "t2", rememberToken: true });
    expect((await loadSettings(p)).token).toBe("t2");
    expect(toStored({ ...DEFAULT_SETTINGS, token: "x", rememberToken: false }).token).toBe("");
  });
  it("falls back to defaults on a missing or corrupt record", async () => {
    const p = memoryProvider();
    expect(await loadSettings(p)).toEqual(DEFAULT_SETTINGS);
    p.items.set("settings", { id: "settings", theme: "neon" } as unknown as Settings);
    expect((await loadSettings(p)).theme).toBe("system");
  });
});
