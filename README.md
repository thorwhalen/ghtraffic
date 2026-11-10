# ghtraffic

Keep your GitHub traffic for longer than 14 days, across all your repos and orgs, and explore it in a dashboard.

GitHub shows a repo's views, clones, referrers and popular pages for the last 14 days only, one repo at a time. `ghtraffic` collects them for every repo you can push to, on a schedule, and merges each run into a growing history of small CSV files in a git repository you own. Star, fork and watcher counts come along, and star history is rebuilt back to each repo's creation. A static dashboard reads that history.

**Dashboard (demo data):** https://thorwhalen.github.io/ghtraffic/

## Quick start: collect with a GitHub Action

1. Create a **private** repository for the data (it will hold the traffic of your private repos too), and add the workflow and config to it:

   ```bash
   pip install ghtraffic
   gh repo create my-traffic-data --private --clone && cd my-traffic-data
   ghtraffic init . --owner @me          # or: --owner me --owner my-org ...
   git add -A && git commit -m "ghtraffic" && git push -u origin main
   ```

   `ghtraffic init` writes two files: `ghtraffic.toml` (what to collect) and `.github/workflows/ghtraffic.yml`, which is all the workflow needs:

   ```yaml
   - uses: actions/checkout@v4
   - uses: thorwhalen/ghtraffic@0.0.2   # the release you installed; pin it
     with:
       token: ${{ secrets.GHTRAFFIC_TOKEN }}
   ```

   The Action is pinned to a release tag (or pin a commit SHA): the token it receives can read every repo it covers, so it should run code you chose, not whatever lands on `main` later. It refuses to commit private repos' data into a public repository (input `allow-public: true` overrides).

   `"@me"` means you **and every organization you belong to**, including client or employer organizations whose repo names and traffic may not be yours to copy. List owners explicitly, or use `exclude = ["client-org/*"]`, when that matters.

2. Create a token with push access to the repos you want: a [classic token with the `repo` and `read:org` scopes](https://github.com/settings/tokens/new?scopes=repo,read:org&description=ghtraffic) covers every owner you can push to (a fine-grained token is limited to one owner). Save it as the data repo's `GHTRAFFIC_TOKEN` secret:

   ```bash
   gh secret set GHTRAFFIC_TOKEN
   ```

3. Run it once by hand (`gh workflow run ghtraffic.yml`), and it will run on its own on Mondays and Thursdays from then on. The first run is the cold start: it takes the 14 days GitHub still has, plus each repo's star history. Every later run merges into what is there; re-running is always safe.

## Look at it

Open the dashboard at https://thorwhalen.github.io/ghtraffic/ and point it at your data repo, or use `#repo=<owner>/<data-repo>` in the URL. Paste a [fine-grained token](https://github.com/settings/personal-access-tokens/new) that can only **read the contents of that one repo**. Your browser fetches the data straight from the GitHub API with it. The page itself is public, holds no data, talks to no host but GitHub, and refuses to run inside a frame. The token stays in memory unless you tick "remember"; a remembered token is readable by any page on the same `<user>.github.io` origin, which is one more reason to give it read access to the data repo only. `?data=<url>` reads a public data directory from `raw.githubusercontent.com` instead.

It shows totals and growth over any time range, by owner and repo, views or clones, totals or uniques, a sortable leaderboard with sparklines, top referrers and pages, and stars and forks over time.

## Collect from your own computer

```bash
ghtraffic collect --owner @me                  # into ~/.local/share/ghtraffic/data
ghtraffic collect --data-dir ./my-traffic-data # into a checkout of your data repo
```

The token comes from `GHTRAFFIC_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`, or from the GitHub CLI (`gh auth login`).

From Python:

```python
from ghtraffic import collect, load_settings, Files

report = collect(load_settings(owners=["@me"], exclude=["my-org/sandbox-*"]), store=Files("~/traffic"))
print(report.summary())
```

`store` is any `MutableMapping[str, str]` (relative path to text): a folder by default, or any [dol](https://github.com/i2mint/dol) store (S3, a database, ...). `rest=` and `graphql=` replace the HTTP transport.

## Configuration

`ghtraffic.toml`, at the data directory's root. Every key is optional.

| key | default | meaning |
|---|---|---|
| `owners` | `["@me"]` | user and org logins; `"@me"` is you and every org you belong to |
| `exclude` | `[]` | `owner/repo` glob patterns to skip (`"my-org/*"` skips an owner) |
| `include_forks` | `true` | collect forks too |
| `include_archived` | `true` | collect archived repos too |
| `snapshot_every_days` | `14` | days between snapshots of referrers, paths and 14-day totals |
| `backfill_stars` | `true` | rebuild a repo's star history the first time it is seen |
| `max_workers` | `8` | concurrent requests |

Unknown keys are refused (a typo never silently falls back to a default). Every key is also a `ghtraffic collect` flag (`--no-include-forks`, `--snapshot-every-days 7`, ...).

Repos you cannot push to have no readable traffic: they are counted and listed in `last_run.json`, never an error. An organization policy refusing the token (SAML SSO, a ban on classic tokens) is an error, listed with the repo, so a whole org never silently reads as zero traffic. The Action log carries counts only; names and messages go to `last_run.json`.

## Data layout

Plain CSV, one table per kind, split by year, sorted by date so each run adds lines at the end of the current year's file. `manifest.json` lists every file and its columns.

| file | rows |
|---|---|
| `views/YYYY.csv`, `clones/YYYY.csv` | `date,repo,count,uniques`: one per repo and day with any traffic (no row means zero) |
| `windows/YYYY.csv` | `fetched,repo,kind,count,uniques`: 14-day totals at each snapshot, the only true 14-day unique counts |
| `referrers/YYYY.csv`, `paths/YYYY.csv` | the top 10 over the 14 days before `fetched`; snapshots are 14 days apart, so they never overlap |
| `stars.csv` | `date,repo,stars,forks,watchers`: a row only when something changed |
| `repos.csv` | current metadata of every repo seen |
| `backfills.csv` | when each repo's star history was rebuilt (a failed backfill is retried next run) |
| `runs.csv`, `last_run.json` | one row per run; the last run's details (repos without access, errors) |

A day seen by several runs keeps the largest value of each field, so overlapping windows, re-runs and partial days all merge to the same result. Why this layout, and the alternatives: [docs/adr/0001-storage.md](docs/adr/0001-storage.md).

## Cost

One job per run, about 1 minute (a few minutes for the cold start with star history). At two runs a week that is about 10 to 20 Actions minutes a month on a private repository, and two missed runs in a row still lose nothing. Data grows by a few MB a year for a few hundred repos.

## Limits

- GitHub keeps traffic for 14 days. Nothing earlier can be recovered, except star history.
- Star history counts current stargazers by the date they starred; unstars are invisible.
- Referrers and paths are GitHub's top 10 per repo only. Snapshots are 14 days apart so they can be added up; a missed snapshot run loses the referrer and path data of the days it slipped by (daily views and clones are unaffected).
- One token for every owner means a classic token (fine-grained tokens are per owner).
