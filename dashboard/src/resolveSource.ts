/**
 * Decide which data source to load, from (in order of precedence):
 * 1. `#repo=owner/name` in the URL hash -> the private GitHub source;
 * 2. `?data=<url>` in the query string -> the URL source;
 * 3. the saved settings (GitHub repo or a custom URL);
 * 4. otherwise the synthetic demo bundled with the site (`<base>/demo/`).
 */
import type { DataRepoCoords } from "./route";
import type { Settings } from "./settings";

export type SourceSpec =
  | { kind: "github"; repo: string; branch: string; path: string; fromHash: boolean }
  | { kind: "url"; url: string; demo: boolean };

export function resolveSource({
  dataRepo,
  dataUrl,
  settings,
  demoUrl,
}: {
  dataRepo: DataRepoCoords | null;
  dataUrl: string | null;
  settings: Settings;
  demoUrl: string;
}): SourceSpec {
  if (dataRepo) {
    return { kind: "github", repo: dataRepo.repo, branch: dataRepo.branch || "main", path: dataRepo.path || "", fromHash: true };
  }
  if (dataUrl) return { kind: "url", url: dataUrl, demo: false };
  if (settings.source === "github" && settings.ghRepo) {
    return { kind: "github", repo: settings.ghRepo, branch: settings.ghBranch || "main", path: settings.ghPath, fromHash: false };
  }
  if (settings.source === "url" && settings.url) return { kind: "url", url: settings.url, demo: false };
  return { kind: "url", url: demoUrl, demo: true };
}
