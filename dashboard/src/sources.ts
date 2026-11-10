/**
 * Where the data comes from: one `DataSource` interface, two implementations.
 *
 * The dashboard only ever asks a source for "the text of relative path X"
 * (`manifest.json`, `views/2026.csv`, ...). Anything that can answer that is a
 * source, so a third backend (a local folder via the File System Access API,
 * an S3 bucket, ...) is one more factory here and nothing else changes.
 *
 * - `urlSource(base)`: plain HTTP GET of `base + path`. The default, used for the
 *   synthetic demo shipped with the public site and for `?data=<url>`.
 * - `githubSource({owner, repo, branch, path, token})`: the GitHub contents API,
 *   for a PRIVATE data repo read from a PUBLIC page. The token is sent only to
 *   `https://api.github.com`, only in the `Authorization` header, never in a URL.
 */

/** What went wrong, in terms the UI can explain (and choose an action for). */
export type SourceErrorKind =
  | "unauthorized" // 401: token missing, wrong or expired
  | "forbidden" // 403: token valid but no access (or rate-limited)
  | "rate-limited" // 403/429 with the rate-limit headers exhausted
  | "not-found" // 404: wrong owner/repo/branch/path, or no access to a private repo
  | "network" // fetch itself failed (offline, CORS, DNS)
  | "http" // any other non-2xx
  | "config"; // the source is not configured well enough to try

export class DataSourceError extends Error {
  constructor(
    public kind: SourceErrorKind,
    message: string,
    public status?: number,
    public path?: string,
  ) {
    super(message);
    this.name = "DataSourceError";
  }
}

/** A place that can hand back text files of a ghtraffic data directory. */
export interface DataSource {
  /** A short label for the UI ("Demo data", "owner/repo@main"). Never contains a token. */
  readonly label: string;
  /** Text of the file at `path` (relative to the data root). Rejects with `DataSourceError`. */
  getText(path: string): Promise<string>;
}

/** The `fetch` signature, injectable so tests can mock the network. */
export type Fetch = typeof fetch;

// ------------------------------------------------------------ URL source

/**
 * A data directory served over HTTP(S) at `baseUrl` (relative URLs resolve
 * against the page). No credentials are sent.
 */
export function urlSource(
  baseUrl: string,
  { fetchFn = globalThis.fetch.bind(globalThis), label }: { fetchFn?: Fetch; label?: string } = {},
): DataSource {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return {
    label: label ?? base,
    async getText(path: string) {
      const url = base + path.replace(/^\/+/, "");
      let res: Response;
      try {
        res = await fetchFn(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      } catch (e) {
        throw new DataSourceError("network", `Could not reach ${url} (${(e as Error).message}).`, undefined, path);
      }
      if (!res.ok) {
        const kind: SourceErrorKind =
          res.status === 404 ? "not-found" : res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : "http";
        throw new DataSourceError(kind, `${url} answered ${res.status}.`, res.status, path);
      }
      return res.text();
    },
  };
}

// ------------------------------------------------------------ GitHub source

export interface GitHubCoords {
  /** "owner/name" of the data repo. */
  repo: string;
  /** Branch, tag or commit. Default "main". */
  branch?: string;
  /** Folder inside the repo holding manifest.json. Default "" (the root). */
  path?: string;
}

export const GITHUB_API = "https://api.github.com";

/** owner/name as GitHub allows them; anything else is refused before any request. */
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const isValidRepo = (repo: string): boolean => REPO_RE.test(repo) && !repo.split("/")[1].startsWith(".");

/** Encode each segment of a path, keeping the slashes. */
const encodePath = (p: string) =>
  p
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map(encodeURIComponent)
    .join("/");

/** The exact URL requested for `file` (exported for tests; never includes the token). */
export function githubContentsUrl({ repo, branch = "main", path = "" }: GitHubCoords, file: string): string {
  const full = encodePath([path, file].filter(Boolean).join("/"));
  return `${GITHUB_API}/repos/${repo}/contents/${full}?ref=${encodeURIComponent(branch || "main")}`;
}

/**
 * A data directory in a (private) GitHub repo, read with a personal token.
 * `Accept: application/vnd.github.raw+json` makes the API return the file's
 * bytes directly (no base64 JSON wrapper, works up to 100 MB).
 */
export function githubSource(
  coords: GitHubCoords & { token: string },
  { fetchFn = globalThis.fetch.bind(globalThis) }: { fetchFn?: Fetch } = {},
): DataSource {
  const { repo, branch = "main", path = "", token } = coords;
  if (!isValidRepo(repo)) {
    throw new DataSourceError("config", `"${repo}" is not a GitHub repository name (expected owner/name).`);
  }
  const where = `${repo}@${branch || "main"}${path ? `:${path}` : ""}`;
  return {
    label: where,
    async getText(file: string) {
      const url = githubContentsUrl({ repo, branch, path }, file);
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await fetchFn(url, { headers, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache" });
      } catch (e) {
        throw new DataSourceError("network", `Could not reach api.github.com (${(e as Error).message}).`, undefined, file);
      }
      if (res.ok) return res.text();
      throw githubError(res, { where, file, hasToken: Boolean(token) });
    },
  };
}

/** Turn a failed GitHub response into an explanation a person can act on. */
function githubError(res: Response, { where, file, hasToken }: { where: string; file: string; hasToken: boolean }) {
  const s = res.status;
  const remaining = res.headers.get("x-ratelimit-remaining");
  if ((s === 403 || s === 429) && remaining === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
    return new DataSourceError("rate-limited", `GitHub's API rate limit is used up.${when}`, s, file);
  }
  if (s === 401) {
    return new DataSourceError(
      "unauthorized",
      hasToken
        ? "GitHub rejected the token (401): it is wrong, expired or revoked. Paste a new one."
        : "This repository needs a token (401). Paste one in Data source.",
      s,
      file,
    );
  }
  if (s === 403) {
    return new DataSourceError(
      "forbidden",
      `The token cannot read ${where} (403). Give it "Contents: read" on that repository.`,
      s,
      file,
    );
  }
  if (s === 404) {
    return new DataSourceError(
      "not-found",
      `${file} was not found in ${where} (404). Check the owner/name, branch and folder` +
        (hasToken ? ", and that the token can see this repository." : "; a private repository also answers 404 without a token."),
      s,
      file,
    );
  }
  return new DataSourceError("http", `GitHub answered ${s} for ${file} in ${where}.`, s, file);
}
