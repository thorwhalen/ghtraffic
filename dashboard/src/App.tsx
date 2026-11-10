/**
 * The page shell: header (source, theme), notices, then either the dashboard or
 * one repo's detail view. All data work lives in the store and aggregate.ts;
 * this file only arranges what to show for each load state.
 */
import { useEffect, useMemo } from "react";
import { freshness } from "./aggregate";
import { fmtDay } from "./dates";
import { KpiRow, MainChart, StarsCard, TopLists } from "./components/Cards";
import { AppliedChips, EmptySelection, FilterBar, FilterSheet } from "./components/Filters";
import { Leaderboard } from "./components/Leaderboard";
import { RepoDetail } from "./components/RepoDetail";
import { SourceDialog } from "./components/SourceDialog";
import { useDelayed } from "./components/ui";
import { onRouteChange } from "./route";
import { THEMES } from "./settings";
import { useStore } from "./store";
import { useView } from "./view";

const THEME_LABEL = { system: "Auto", light: "Light", dark: "Dark" } as const;

function ThemeButton() {
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateSettings);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return (
    <button type="button" className="chip-btn" onClick={() => update({ theme: next })} aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}.`}>
      {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"} {THEME_LABEL[theme]}
    </button>
  );
}

function Header() {
  const load = useStore((s) => s.load);
  const dataset = useStore((s) => s.dataset);
  const setSourceOpen = useStore((s) => s.setSourceOpen);
  const fresh = useMemo(() => (dataset ? freshness(dataset) : null), [dataset]);
  const spec = load.spec;
  const sourceName = !spec ? "…" : spec.kind === "github" ? spec.repo : spec.demo ? "Demo data" : "Data URL";
  return (
    <header className="app-head">
      <div className="app-head-row">
        <h1 className="brand">ghtraffic</h1>
        <div className="head-actions">
          <button type="button" className="chip-btn source-btn" onClick={() => setSourceOpen(true)} aria-haspopup="dialog">
            <span className={`dot dot-${load.status}`} aria-hidden="true" />
            {sourceName}
          </button>
          <ThemeButton />
        </div>
      </div>
      {fresh && (
        <p className="freshness">
          Updated {fmtDay(fresh.updated.slice(0, 10), { year: true })}
          {fresh.noAccess ? ` · ${fresh.noAccess} repo${fresh.noAccess > 1 ? "s" : ""} without traffic access` : ""}
          {spec?.kind === "url" && spec.demo ? " · synthetic demo data" : ""}
        </p>
      )}
    </header>
  );
}

function Notices() {
  const dataset = useStore((s) => s.dataset);
  const load = useStore((s) => s.load);
  const setSourceOpen = useStore((s) => s.setSourceOpen);
  return (
    <>
      {load.status === "error" && load.error && (
        <div className="notice notice-error" role="alert">
          <strong>Could not load the data.</strong> {load.error.message}{" "}
          <button type="button" className="link-btn" onClick={() => setSourceOpen(true)}>
            Change data source
          </button>
        </div>
      )}
      {dataset && dataset.warnings.length > 0 && (
        <details className="notice notice-warn">
          <summary>
            The data differs from what this dashboard expects ({dataset.warnings.length} note{dataset.warnings.length > 1 ? "s" : ""}).
          </summary>
          <ul>
            {dataset.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Loading() {
  const load = useStore((s) => s.load);
  const show = useDelayed(load.status === "loading");
  if (!show) return null;
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="kpis skeleton-row">
        {Array.from({ length: 5 }, (_, i) => (
          <div className="tile skeleton" key={i} />
        ))}
      </div>
      <div className="card skeleton tall" />
      <p className="muted">Loading{load.progress ? ` ${load.progress[0]} of ${load.progress[1]} files` : "…"}</p>
    </div>
  );
}

function Freshness() {
  const dataset = useStore((s) => s.dataset)!;
  const f = useMemo(() => freshness(dataset), [dataset]);
  return (
    <footer className="foot">
      <p>
        Source: {dataset.sourceLabel} · data updated {f.updated}
        {f.lastRun ? ` · last run ${f.lastRun.replace("T", " ").slice(0, 16)} UTC` : ""}
        {f.errors ? ` · ${f.errors} error(s) in the last run` : ""}
      </p>
      {f.noAccess ? (
        <details>
          <summary>
            {f.noAccess} repo{f.noAccess > 1 ? "s" : ""} without traffic access (the collecting token lacks push rights)
          </summary>
          {f.noAccessRepos.length ? <p>{f.noAccessRepos.join(", ")}</p> : <p className="muted">Names are not in this data.</p>}
        </details>
      ) : null}
      <p className="muted">
        Daily uniques are not additive: a visitor counted on two days, or on two repos, appears twice in a sum. The 14-day figures come from
        GitHub's own 14-day snapshots.
      </p>
    </footer>
  );
}

function Dashboard() {
  const view = useView();
  const refetching = useStore((s) => s.load.status === "loading");
  if (!view) return null;
  const detail = view.f.detail;
  return (
    // While a new source loads, the old frame stays at reduced opacity (no skeleton flash).
    <div className={refetching ? "refetching" : ""}>
      <FilterBar view={view} />
      <FilterSheet view={view} />
      <main className="main">
        {detail ? (
          <RepoDetail view={view} repo={detail} />
        ) : (
          <>
            <AppliedChips f={view.f} />
            {view.repos.length === 0 ? (
              <EmptySelection f={view.f} />
            ) : (
              <>
                <KpiRow view={view} />
                <div className="grid">
                  <MainChart view={view} />
                  <Leaderboard view={view} />
                  <TopLists view={view} />
                  <StarsCard view={view} className="span-2" />
                </div>
              </>
            )}
          </>
        )}
        <Freshness />
      </main>
    </div>
  );
}

export function App() {
  const init = useStore((s) => s.init);
  const syncFromUrl = useStore((s) => s.syncFromUrl);
  const theme = useStore((s) => s.settings.theme);
  const hasData = useStore((s) => s.dataset !== null);

  useEffect(() => {
    void init();
    return onRouteChange(syncFromUrl);
  }, [init, syncFromUrl]);

  useEffect(() => {
    // "system" removes the stamp so the OS setting (prefers-color-scheme) applies.
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <>
      <Header />
      <Notices />
      {hasData ? <Dashboard /> : <Loading />}
      <SourceDialog />
    </>
  );
}
