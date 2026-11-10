/**
 * The filter row (sticky, above everything it scopes), the applied-filter chips,
 * and the filter sheet.
 *
 * Faceted-filter rules applied here:
 * - the connective is said in words where it applies ("any of these owners");
 * - active filters show as removable chips both in the sheet and above the
 *   results;
 * - every change is one history entry (Back undoes it), via store.setFilters;
 * - counts beside owners are conjunctive (they respect the other filters).
 */
import { useMemo, useState } from "react";
import { isVisible } from "../aggregate";
import { fmtSpan } from "../dates";
import { activeFilterCount, DEFAULT_FILTERS, KINDS, MEASURES, RANGES, type Filters } from "../filters";
import { useStore } from "../store";
import type { View } from "../view";
import { Segmented, Sheet } from "./ui";

const RANGE_LABELS: Record<(typeof RANGES)[number], string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "1y": "1y",
  all: "All",
  custom: "Custom",
};

export function FilterBar({ view }: { view: View }) {
  const f = view.f;
  const setFilters = useStore((s) => s.setFilters);
  const setFiltersOpen = useStore((s) => s.setFiltersOpen);
  const n = activeFilterCount(f);
  return (
    <div className="filterbar">
      <div className="filterbar-inner">
        <Segmented
          className="range-seg"
          label="Time range"
          options={RANGES}
          labels={RANGE_LABELS}
          value={f.range}
          onChange={(range) =>
            setFilters(range === "custom" ? { range, from: f.from ?? view.range.start, to: f.to ?? view.range.end } : { range })
          }
        />
        <div className="filterbar-row">
          <Segmented label="Metric" options={KINDS} labels={{ views: "Views", clones: "Clones" }} value={f.kind} onChange={(kind) => setFilters({ kind })} />
          <Segmented
            label="Measure"
            options={MEASURES}
            labels={{ count: "Total", uniques: "Uniques" }}
            value={f.measure}
            onChange={(measure) => setFilters({ measure })}
          />
          <button type="button" className="filters-btn" aria-haspopup="dialog" onClick={() => setFiltersOpen(true)}>
            Filters{n > 0 && <span className="badge">{n}</span>}
          </button>
        </div>
        {f.range === "custom" && (
          <div className="custom-range">
            <label>
              From
              <input type="date" value={f.from ?? view.range.start} max={view.idx.anchor} onChange={(e) => setFilters({ from: e.target.value || undefined }, { replace: true })} />
            </label>
            <label>
              To
              <input type="date" value={f.to ?? view.range.end} max={view.idx.anchor} onChange={(e) => setFilters({ to: e.target.value || undefined }, { replace: true })} />
            </label>
          </div>
        )}
        <p className="range-note">
          {fmtSpan(view.range.start, view.range.end)} · {view.repos.length} of {view.idx.repos.size} repos
        </p>
      </div>
    </div>
  );
}

/** One removable chip per active scoping filter, plus "Clear all". */
export function AppliedChips({ f }: { f: Filters }) {
  const setFilters = useStore((s) => s.setFilters);
  const chips: { key: string; label: string; remove: Partial<Filters> }[] = [
    ...f.owners.map((o) => ({ key: `o:${o}`, label: `Owner: ${o}`, remove: { owners: f.owners.filter((x) => x !== o) } })),
    ...f.repos.map((r) => ({ key: `r:${r}`, label: r, remove: { repos: f.repos.filter((x) => x !== r) } })),
    ...(
      [
        ["pub", "No public"],
        ["priv", "No private"],
        ["forks", "No forks"],
        ["archived", "No archived"],
      ] as const
    )
      .filter(([k]) => !f[k])
      .map(([k, label]) => ({ key: k, label, remove: { [k]: true } as Partial<Filters> })),
  ];
  if (!chips.length) return null;
  return (
    <div className="applied" aria-label="Active filters">
      {chips.map((c) => (
        <button key={c.key} type="button" className="chip removable" onClick={() => setFilters(c.remove)} aria-label={`Remove filter ${c.label}`}>
          {c.label} <span aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="link-btn" onClick={() => setFilters(clearScoping)}>
        Clear all
      </button>
    </div>
  );
}

const clearScoping: Partial<Filters> = {
  owners: [],
  repos: [],
  pub: DEFAULT_FILTERS.pub,
  priv: DEFAULT_FILTERS.priv,
  forks: DEFAULT_FILTERS.forks,
  archived: DEFAULT_FILTERS.archived,
};

export function FilterSheet({ view }: { view: View }) {
  const open = useStore((s) => s.filtersOpen);
  const setOpen = useStore((s) => s.setFiltersOpen);
  const setFilters = useStore((s) => s.setFilters);
  const { idx, f } = view;
  const [q, setQ] = useState("");

  const all = useMemo(() => [...idx.repos.values()], [idx]);
  // Conjunctive counts: repos per owner that also pass the visibility toggles.
  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) if (isVisible(r, f)) m.set(r.owner, (m.get(r.owner) ?? 0) + 1);
    return m;
  }, [all, f]);
  const ownersSet = new Set(f.owners);
  const reposSet = new Set(f.repos);
  const candidates = all
    .filter((r) => (!ownersSet.size || ownersSet.has(r.owner)) && isVisible(r, f))
    .filter((r) => !q || r.repo.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      title="Filters"
      footer={
        <>
          <button type="button" className="link-btn" onClick={() => setFilters(clearScoping)}>
            Reset filters
          </button>
          <button type="button" className="primary-btn" onClick={() => setOpen(false)}>
            Show {view.repos.length} repos
          </button>
        </>
      }
    >
      <AppliedChips f={f} />

      <fieldset>
        <legend>Owner or organisation</legend>
        <p className="hint">Repos from any of the selected owners (none selected = all).</p>
        <div className="chip-row">
          {idx.owners.map((o) => (
            <button key={o} type="button" className="chip" aria-pressed={ownersSet.has(o)} onClick={() => setFilters({ owners: toggle(f.owners, o) })}>
              {o} <span className="count">{ownerCounts.get(o) ?? 0}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Visibility</legend>
        <p className="hint">Include repos that are… (combined with the owner filter: both must match).</p>
        <div className="toggle-grid">
          {(
            [
              ["pub", "Public"],
              ["priv", "Private"],
              ["forks", "Forks"],
              ["archived", "Archived"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="toggle">
              <input type="checkbox" checked={f[k]} onChange={(e) => setFilters({ [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Repositories</legend>
        <p className="hint">Only the selected repos (none selected = every repo matching the filters above).</p>
        <input
          type="search"
          className="search"
          placeholder={`Search ${candidates.length} repos`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search repositories"
        />
        <ul className="repo-pick">
          {candidates.map((r) => (
            <li key={r.repo}>
              <label>
                <input type="checkbox" checked={reposSet.has(r.repo)} onChange={() => setFilters({ repos: toggle(f.repos, r.repo) })} />
                <span>{r.repo}</span>
                {r.private && <span className="tag">private</span>}
                {r.archived && <span className="tag">archived</span>}
                {r.fork && <span className="tag">fork</span>}
              </label>
            </li>
          ))}
          {candidates.length === 0 && <li className="hint">No repo matches “{q}”.</li>}
        </ul>
      </fieldset>
    </Sheet>
  );
}

/** The empty state names what to relax (faceted-filter rule 4). */
export function EmptySelection({ f }: { f: Filters }) {
  const setFilters = useStore((s) => s.setFilters);
  const parts: string[] = [];
  if (f.owners.length) parts.push(`owner ${f.owners.join(" or ")}`);
  if (f.repos.length) parts.push(`${f.repos.length} picked repo(s)`);
  const hidden = (["pub", "priv", "forks", "archived"] as const).filter((k) => !f[k]);
  if (hidden.length) parts.push(`hiding ${hidden.map((k) => ({ pub: "public", priv: "private", forks: "forks", archived: "archived" })[k]).join(", ")}`);
  return (
    <div className="card empty">
      <h2>No repositories match</h2>
      <p>The filters select nothing: {parts.join("; ") || "no repos in the data"}.</p>
      <div className="empty-actions">
        {f.owners.length > 0 && (
          <button type="button" className="chip-btn" onClick={() => setFilters({ owners: [] })}>
            Any owner
          </button>
        )}
        {f.repos.length > 0 && (
          <button type="button" className="chip-btn" onClick={() => setFilters({ repos: [] })}>
            Any repo
          </button>
        )}
        <button type="button" className="primary-btn" onClick={() => setFilters(clearScoping)}>
          Clear all filters
        </button>
      </div>
    </div>
  );
}
