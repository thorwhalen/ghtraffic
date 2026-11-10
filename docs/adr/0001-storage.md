# ADR 0001: how the traffic history is stored

- Status: accepted
- Date: 2026-11-10

## Context

GitHub keeps repository traffic for 14 days. `views` and `clones` come as daily series plus 14-day window totals; `popular/referrers` and `popular/paths` are top-10 aggregates over those 14 days, with no daily breakdown [1]. All four need push access. Stars, forks and watchers are current values only.

The collector runs as one scheduled GitHub Action in a **private** data repository, over every repo of a user and their organizations (hundreds of repos). The history must:

- accumulate across runs, with overlapping 14-day windows merged idempotently;
- stay git-friendly for years: small diffs, little repository growth;
- be readable by a static dashboard over the GitHub contents API, in a few requests;
- need nothing beyond the Python standard library to write;
- cost few Actions minutes, since private-repo minutes are scarce.

Behaviour of the API that matters, checked against the live API on 2026-11-10: zero days are returned explicitly (older reports say they were omitted [4]); the current, partial UTC day was not returned (older collectors saw it [3]); a day's value can read lower when it sits at the window's left edge, because the rolling window has sub-day precision [3]; window `uniques` are not the sum of daily `uniques`.

## Decision

**Long-form CSV, one table per kind, partitioned by year, sorted by time.** `views/YYYY.csv`, `clones/YYYY.csv` (`date,repo,count,uniques`), `windows/YYYY.csv`, `referrers/YYYY.csv`, `paths/YYYY.csv`, plus unpartitioned `stars.csv`, `repos.csv` and `runs.csv`, and a `manifest.json` listing every file and its columns. The schema lives in one place, `ghtraffic.tables.TABLES`; the manifest is generated from it, and the dashboard checks the manifest against its own copy.

**Sparse daily rows.** A day with zero views (or clones) has no row; absence means zero. Most repo-days are zero, so this keeps files small, and it reads old and new API behaviour the same way.

**Merge rules, per table:**

- `views`, `clones`: per `(date, repo)`, each field keeps the **maximum** seen. Max is idempotent, commutative and associative, so re-runs, overlapping windows, partial days and left-edge truncation all merge to the same result, in any order. This is jgehrcke/github-repo-stats' rule [2][3]. Latest-wins or row-replacement merges (used by other tools [5][6]) let a truncated edge value overwrite a complete one.
- `windows`, `referrers`, `paths`: a snapshot is a group `(fetched, repo)`; a new snapshot of the same group replaces the old rows (a same-day re-run leaves no stale referrer behind).
- `stars`: a **change-only log**: a row is written only when stars, forks or watchers differ from the repo's previous row. Daily copies of slowly changing values would be hundreds of thousands of rows a year; the log is a few hundred.
- `repos`: upsert by repo, the latest row wins; repos are kept after they disappear (`last_seen`).

**Snapshot cadence: 14 days** (`snapshot_every_days`). A snapshot is due when the repo's last one is 14 or more days old, so successive windows tile time without overlapping, and their counts can be added up (within top-10 truncation). Weekly snapshots would double the size and overlap.

**Run cadence: twice a week** (Mondays and Thursdays, 03:17 UTC, off the hour). Each day is seen 3 or 4 times inside its window, two missed runs in a row lose nothing, and it costs about 9 one-minute jobs a month. One job covers every owner; a matrix would bill a rounded-up minute per repo.

**Star history** is rebuilt once per repo, from each current stargazer's `starredAt` (GraphQL), as cumulative counts per day. A `backfills` table records which repos are done, so a failed backfill is retried and a successful one is never repeated; `collect(star_history=...)` is the seam for a better source. In the `stars` log, rows of the same day merge field-wise (an empty backfilled value never erases a live one) and a row equal to its predecessor is dropped.

**Store seam.** The tables are written through a `MutableMapping[str, str]` (relative path to text): a local folder by default (atomic writes), or any `dol` store.

## Alternatives rejected

- **Existing tools** [2][5][6][7][8]: per-repo jobs or caller workflows (hundreds of billed jobs per run), Docker and pandas, public gists, GPL or no licence. We adopt jgehrcke's max rule and change-only star log rather than the tool.
- **Per-repo files**: nice diffs, but the dashboard would need one request per repo, and directory listings stop at 1,000 entries [11].
- **Partition by owner**: every overview needs every owner anyway; year partitions make past years immutable.
- **JSON/NDJSON**: keys repeat on every row. **Parquet, SQLite, gzipped CSV in git**: binary, so every run stores a near-full new blob. If bytes ever matter, gzip is a build artifact, not the stored format.
- **Git scraping** (overwrite one file, history in git log) [9][10]: the dashboard reads through the contents API, which does not see history.
- **A wide daily table** (`views,views_uniques,clones,clones_uniques` in one row): half the rows, but views and clones then share a sparsity pattern (a clone-only day writes a zero view). Kept separate.

## Consequences

- A repo's traffic before ghtraffic first saw it is unknown, not zero. `runs.csv` gives the coverage start; per-repo coverage (`first_seen`) is a follow-up.
- Max cannot follow a genuine downward revision by GitHub; none has been reported except the edge artifact max exists to ignore.
- Snapshot tiling trades robustness for addability: a snapshot run that is missed (a dropped cron, a failed call) delays the next one by 3 or 4 days, and the referrer and path data of those days is lost. Taking snapshots every 10 days would never lose data but windows would overlap and could no longer be summed. We keep 14 and accept the rare gap; daily series are not affected.
- Referrers and paths are up to 14 days stale between snapshots. A `latest` table overwritten each run would fix that at the cost of two more calls per repo per run; a follow-up.
- `starredAt` listing is limited to people with push access [16]. GitHub's newer star-history endpoint (2026-09-04) gives daily deltas back to creation without identities [14][15] and should replace it.
- Size, for a few hundred repos: a few MB a year in total; the dashboard reads one year file per table. A monthly rollup for the overview is a follow-up if load time suffers.

## References

1. GitHub Docs. [REST API endpoints for repository traffic](https://docs.github.com/en/rest/metrics/traffic).
2. Gehrcke J. [jgehrcke/github-repo-stats](https://github.com/jgehrcke/github-repo-stats) (Apache-2.0).
3. Gehrcke J. [analyze.py: the views/clones aggregation and the max rule](https://github.com/jgehrcke/github-repo-stats/blob/main/analyze.py).
4. Gehrcke J. [github-repo-stats issue 4: NaN values mean zero](https://github.com/jgehrcke/github-repo-stats/issues/4).
5. Gonzalez S. [sangonzal/repository-traffic-action](https://github.com/sangonzal/repository-traffic-action) (MIT).
6. groda. [groda/github-traffic-archiver](https://github.com/groda/github-traffic-archiver) (MIT).
7. djdarcy. [github-traffic-tracker](https://pypi.org/project/github-traffic-tracker/) (GPL-3.0).
8. CCP-NC. [CCP-NC/metrics](https://github.com/CCP-NC/metrics).
9. Willison S. [Git scraping: track changes over time by scraping to a Git repository](https://simonwillison.net/2020/Oct/9/git-scraping/). 2020.
10. Willison S. [simonw/git-history](https://github.com/simonw/git-history) (Apache-2.0).
11. GitHub Docs. [REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents).
12. GitHub Docs. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
13. GitHub Docs. [Events that trigger workflows: schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
14. Star History. [The new GitHub star history API](https://www.star-history.com/blog/new-github-star-history-api). 2026-09-05.
15. GitHub Changelog. [New API endpoint provides privacy-safe star history data](https://github.blog/changelog/2026-09-04-new-api-endpoint-provides-privacy-safe-star-history-data/). 2026-09-04.
16. GitHub Docs. [REST API endpoints for starring](https://docs.github.com/en/rest/activity/starring).
