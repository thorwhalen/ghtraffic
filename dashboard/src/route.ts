/**
 * The URL hash <-> view state. The ONLY module that touches `history`.
 *
 * Hash format: `#range=30d&kind=clones&owners=a,b&repo=me/traffic-data`,
 * keys sorted, defaults omitted, so one view has exactly one spelling.
 *
 * Two kinds of state share the hash:
 * - the view (`Filters`, see filters.ts);
 * - the data repo coordinates (`repo`, `branch`, `path`) for the private GitHub
 *   source, so that view is bookmarkable too. The TOKEN never goes in a URL.
 *
 * History policy (tw-frontend-ux principle 2, faceted-filter-ux rule 3):
 * - a filter change PUSHES one entry, so Back undoes it;
 * - opening a repo's detail PUSHES; closing it goes Back when the entry
 *   underneath is ours, otherwise REPLACES (a pasted link has nothing under it);
 * - canonicalising the URL (first load, source change) REPLACES.
 */
import { DEFAULT_FILTERS, FiltersSchema, type Filters } from "./filters";

export interface DataRepoCoords {
  repo: string;
  branch?: string;
  path?: string;
}

export interface Route {
  filters: Filters;
  dataRepo: DataRepoCoords | null;
}

const LIST_KEYS = new Set(["owners", "repos"]);
const BOOL_KEYS = new Set(["pub", "priv", "forks", "archived", "desc"]);

/** Parse `#a=b&c=d` (with or without the `#`) into a `Route`. Never throws. */
export function parseHash(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const raw: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (LIST_KEYS.has(k)) raw[k] = v.split(",").filter(Boolean);
    else if (BOOL_KEYS.has(k)) raw[k] = v === "1" || v === "true";
    else raw[k] = v;
  }
  const filters = FiltersSchema.parse(raw);
  const repo = params.get("repo");
  const dataRepo = repo
    ? { repo, branch: params.get("branch") || undefined, path: params.get("path") || undefined }
    : null;
  return { filters, dataRepo };
}

/** The canonical hash (without `#`) of a route: defaults omitted, keys sorted. */
export function formatHash({ filters, dataRepo }: Route): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(filters) as [keyof Filters, unknown][]) {
    if (v === undefined) continue;
    const dflt = DEFAULT_FILTERS[k];
    if (Array.isArray(v)) {
      if (v.length) entries.push([k, v.join(",")]);
    } else if (typeof v === "boolean") {
      if (v !== dflt) entries.push([k, v ? "1" : "0"]);
    } else if (v !== dflt) entries.push([k, String(v)]);
  }
  if (dataRepo) {
    entries.push(["repo", dataRepo.repo]);
    if (dataRepo.branch && dataRepo.branch !== "main") entries.push(["branch", dataRepo.branch]);
    if (dataRepo.path) entries.push(["path", dataRepo.path]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  // URLSearchParams would encode "/" and ","; keep them readable.
  return entries.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2F/g, "/").replace(/%2C/g, ",")}`).join("&");
}

/** Marker in `history.state`: "this entry was pushed by the app". */
const FROM_APP = "ghtraffic";

/** Write a route to the URL. `replace` for canonicalising; push otherwise. */
export function writeRoute(route: Route, { replace = false } = {}): void {
  const hash = formatHash(route);
  const url = `${location.pathname}${location.search}${hash ? "#" + hash : ""}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) return; // never push the URL we are on
  if (replace) history.replaceState(history.state, "", url);
  else history.pushState({ from: FROM_APP }, "", url);
}

/** Close an overlay opened by a push: Back if the entry under it is ours, else replace. */
export function leaveTo(route: Route): void {
  if (history.state?.from === FROM_APP) history.back();
  else writeRoute(route, { replace: true });
}

/** Call `fn` whenever the URL changes from outside the app (Back, Forward, a pasted hash). */
export function onRouteChange(fn: (route: Route) => void): () => void {
  const handler = () => fn(parseHash(location.hash));
  window.addEventListener("popstate", handler);
  window.addEventListener("hashchange", handler);
  return () => {
    window.removeEventListener("popstate", handler);
    window.removeEventListener("hashchange", handler);
  };
}

/** `?data=<url>` override for the URL source, if present. */
export const dataUrlParam = (): string | null => new URLSearchParams(location.search).get("data");
