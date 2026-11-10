/**
 * The app state: one zustand store, mutated through immer.
 *
 * Why zustand + immer: components subscribe to just the slice they read (so a
 * filter change does not re-render the source dialog), and immer lets actions
 * be written as plain mutations (`s.load.status = "ready"`) while the store
 * stays immutable underneath.
 *
 * Derived numbers (series, totals, leaderboard) are NOT stored: they are
 * computed from `index` + `route.filters` with `useMemo` where they are drawn.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { buildIndex, type Index } from "./aggregate";
import type { Filters } from "./filters";
import { loadDataset, type Dataset } from "./load";
import { resolveSource, type SourceSpec } from "./resolveSource";
import { dataUrlParam, leaveTo, parseHash, writeRoute, type Route } from "./route";
import { DEFAULT_SETTINGS, defaultSettingsProvider, loadSettings, saveSettings, type Settings } from "./settings";
import { DataSourceError, githubSource, urlSource, type DataSource } from "./sources";

export interface LoadState {
  status: "idle" | "loading" | "ready" | "error";
  progress: [number, number] | null;
  error: { kind: string; message: string } | null;
  /** The source being shown (or attempted). */
  spec: SourceSpec | null;
}

interface State {
  route: Route;
  settings: Settings;
  /** True when a saved settings record was found (so "forget" has something to forget). */
  settingsSaved: boolean;
  load: LoadState;
  dataset: Dataset | null;
  index: Index | null;
  sourceOpen: boolean;
  filtersOpen: boolean;

  init(): Promise<void>;
  setFilters(patch: Partial<Filters>, opts?: { replace?: boolean }): void;
  syncFromUrl(route: Route): void;
  openDetail(repo: string): void;
  closeDetail(): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  /** Point the dashboard at a source (from the source dialog) and load it. */
  applySource(patch: Partial<Settings>): Promise<void>;
  forgetToken(): Promise<void>;
  reload(): Promise<void>;
  setSourceOpen(open: boolean): void;
  setFiltersOpen(open: boolean): void;
}

const provider = defaultSettingsProvider();
const demoUrl = () => `${import.meta.env.BASE_URL}demo/`;

/** Increments on every load, so a slow, superseded load cannot overwrite a newer one. */
let loadSeq = 0;

function makeSource(spec: SourceSpec, token: string): DataSource {
  return spec.kind === "github"
    ? githubSource({ repo: spec.repo, branch: spec.branch, path: spec.path, token })
    : urlSource(spec.url, { label: spec.demo ? "Demo data (synthetic)" : spec.url });
}

export const useStore = create<State>()(
  immer((set, get) => ({
    route: parseHash(typeof location === "undefined" ? "" : location.hash),
    settings: DEFAULT_SETTINGS,
    settingsSaved: false,
    load: { status: "idle", progress: null, error: null, spec: null },
    dataset: null,
    index: null,
    sourceOpen: false,
    filtersOpen: false,

    async init() {
      const settings = await loadSettings(provider);
      set((s) => {
        s.settings = settings;
        s.settingsSaved = settings !== DEFAULT_SETTINGS;
      });
      await get().reload();
    },

    setFilters(patch, { replace = false } = {}) {
      const route = { ...get().route, filters: { ...get().route.filters, ...patch } };
      writeRoute(route, { replace });
      set((s) => {
        s.route = route;
      });
    },

    syncFromUrl(route) {
      const prev = get().route;
      set((s) => {
        s.route = route;
      });
      // A pasted link that names a different data repo means: load that repo.
      if (JSON.stringify(prev.dataRepo) !== JSON.stringify(route.dataRepo)) void get().reload();
    },

    openDetail(repo) {
      const route = { ...get().route, filters: { ...get().route.filters, detail: repo } };
      writeRoute(route); // push: Back closes the detail view
      set((s) => {
        s.route = route;
      });
      window.scrollTo({ top: 0 });
    },

    closeDetail() {
      const route = { ...get().route, filters: { ...get().route.filters, detail: undefined } };
      leaveTo(route);
      set((s) => {
        s.route = route;
      });
    },

    async updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set((s) => {
        s.settings = settings;
      });
      const ok = await saveSettings(provider, settings);
      set((s) => {
        s.settingsSaved = ok;
      });
    },

    async applySource(patch) {
      await get().updateSettings(patch);
      const { settings, route } = get();
      // Keep the data repo bookmarkable (never the token); drop it for URL sources.
      const dataRepo =
        settings.source === "github" && settings.ghRepo
          ? { repo: settings.ghRepo, branch: settings.ghBranch || "main", path: settings.ghPath || undefined }
          : null;
      const next = { ...route, dataRepo };
      writeRoute(next, { replace: true });
      set((s) => {
        s.route = next;
      });
      await get().reload();
    },

    async forgetToken() {
      await get().updateSettings({ token: "" });
    },

    async reload() {
      const seq = ++loadSeq;
      const { route, settings } = get();
      const spec = resolveSource({ dataRepo: route.dataRepo, dataUrl: dataUrlParam(), settings, demoUrl: demoUrl() });
      if (spec.kind === "github" && !spec.fromHash) {
        // Source came from saved settings: put the repo in the hash so the view is bookmarkable.
        const next = { ...route, dataRepo: { repo: spec.repo, branch: spec.branch, path: spec.path || undefined } };
        writeRoute(next, { replace: true });
        set((s) => {
          s.route = next;
        });
      }
      set((s) => {
        s.load = { status: "loading", progress: null, error: null, spec };
      });
      try {
        const source = makeSource(spec, settings.token);
        const dataset = await loadDataset(source, {
          onProgress: (done, total) => {
            if (seq === loadSeq)
              set((s) => {
                s.load.progress = [done, total];
              });
          },
        });
        if (seq !== loadSeq) return;
        // Datasets are large and read-only. Freezing the top object makes immer
        // skip it (it never walks into frozen objects), so nothing is copied.
        const index = Object.freeze(buildIndex(dataset));
        Object.freeze(dataset);
        set((s) => {
          s.dataset = dataset as never;
          s.index = index as never;
          s.load = { status: "ready", progress: null, error: null, spec };
        });
      } catch (e) {
        if (seq !== loadSeq) return;
        const err =
          e instanceof DataSourceError ? { kind: e.kind, message: e.message } : { kind: "error", message: (e as Error).message };
        set((s) => {
          s.load = { status: "error", progress: null, error: err, spec };
          // A GitHub auth problem is fixed in the source dialog: open it.
          if (spec.kind === "github" && ["unauthorized", "forbidden", "not-found", "config"].includes(err.kind)) s.sourceOpen = true;
        });
      }
    },

    setSourceOpen(open) {
      set((s) => {
        s.sourceOpen = open;
      });
    },
    setFiltersOpen(open) {
      set((s) => {
        s.filtersOpen = open;
      });
    },
  })),
);
