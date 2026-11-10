"""The collection run: list repos, fetch what GitHub still holds, merge it in.

:func:`collect` is the one orchestrator. It is safe to run any number of times
a day and in any order: every table merges idempotently (see
:mod:`ghtraffic.tables`), so the cold start (the first 14-day backfill) and the
daily update are the same call.

Repos the token cannot push to have no readable traffic: they are counted and
listed in ``last_run.json``, never treated as a failure.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterable, MutableMapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from functools import partial
from datetime import date, datetime, timezone

from ghtraffic.config import DFLT_DATA_DIR, Settings
from ghtraffic.github import GitHubError, GraphQL, Rest, make_graphql, make_rest
from ghtraffic.repos import list_repos
from ghtraffic.tables import (
    MANIFEST_KEY,
    SCHEMA_VERSION,
    TABLES,
    Files,
    read_table,
    table_files,
    write_rows,
)
from ghtraffic.traffic import fetch_daily, fetch_popular, star_history

LAST_RUN_KEY = "last_run.json"
_log = logging.getLogger("ghtraffic")
#: HTTP statuses meaning "this token cannot read this repo's traffic".
NO_ACCESS_STATUSES = frozenset({401, 403, 404})


@dataclass
class RunReport:
    """What a run did, for logs and ``last_run.json``."""

    started_at: str
    duration_s: float = 0.0
    repos_listed: int = 0
    repos_collected: int = 0
    snapshots: int = 0
    no_access: list[str] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)
    owner_errors: dict[str, str] = field(default_factory=dict)
    files_changed: int = 0

    def summary(self) -> str:
        """One human line, with no repo names (safe for public logs)."""
        return (
            f"ghtraffic: {self.repos_listed} repos listed, "
            f"{self.repos_collected} collected ({self.snapshots} snapshots), "
            f"{len(self.no_access)} without push access, "
            f"{len(self.errors)} errors, {len(self.owner_errors)} owner errors, "
            f"{self.files_changed} files changed in {self.duration_s:.1f}s"
        )


def _last_snapshots(store: MutableMapping, today: date) -> dict[str, str]:
    years = {str(today.year), str(today.year - 1)}
    last: dict[str, str] = {}
    for r in read_table(store, TABLES["windows"], years=years):
        last[r["repo"]] = max(last.get(r["repo"], ""), str(r["fetched"]))
    return last


def _snapshot_due(last: str | None, today: date, every_days: int) -> bool:
    if not last:
        return True
    return (today - date.fromisoformat(last)).days >= every_days


def write_manifest(store: MutableMapping, *, updated: str) -> dict:
    """Write ``manifest.json``: the schema and the files of every table."""
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "updated": updated,
        "tables": {
            name: {
                "files": table_files(store, spec),
                "columns": list(spec.columns),
                "key": list(spec.key),
                "description": spec.description,
            }
            for name, spec in TABLES.items()
        },
    }
    text = json.dumps(manifest, indent=2) + "\n"
    if store.get(MANIFEST_KEY) != text:
        store[MANIFEST_KEY] = text
    return manifest


def _safely(fn: Callable, repo: str):
    """``(repo, fn(repo), None)``, or ``(repo, None, error)``: one repo never sinks a run."""
    try:
        return repo, fn(repo), None
    except Exception as e:  # noqa: BLE001 - any failure is recorded per repo
        return repo, None, e


def _repo_row(r: dict, last_seen: str) -> dict:
    return {
        **{c: r.get(c, "") for c in TABLES["repos"].columns},
        "last_seen": last_seen,
    }


def collect(
    settings: Settings,
    *,
    store: MutableMapping | None = None,
    rest: Rest | None = None,
    graphql: GraphQL | None = None,
    list_repos: Callable[..., Iterable[dict]] = list_repos,
    star_history: Callable[..., list[dict]] = star_history,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    log: Callable[[str], None] = _log.info,
) -> RunReport:
    """Run one collection into ``store`` and return its report.

    Args:
        settings: what to collect (:func:`~ghtraffic.config.load_settings`).
        store: where the history lives; default ``~/.local/share/ghtraffic/data``.
        rest, graphql: GitHub transports; default urllib with an env token.
        list_repos: ``(owners, *, graphql, rest, exclude, include_forks,
            include_archived, on_error) -> records`` with the keys of
            :data:`~ghtraffic.repos.REPO_FIELDS`.
        star_history: ``(repo, *, graphql) -> stars rows``, for the backfill.
        now: the clock; log: where the one-line summary goes.
    """
    store = Files(DFLT_DATA_DIR) if store is None else store
    rest = rest or make_rest()
    graphql = graphql or make_graphql()
    t0 = time.monotonic()
    started = now()
    today = started.date()
    fetched = today.isoformat()
    report = RunReport(started_at=started.isoformat(timespec="seconds"))
    workers = max(1, settings.max_workers)

    def on_owner_error(owner: str, e: Exception) -> None:
        report.owner_errors[owner] = str(e)

    repos = list(
        list_repos(
            settings.owners,
            graphql=graphql,
            rest=rest,
            exclude=settings.exclude,
            include_forks=settings.include_forks,
            include_archived=settings.include_archived,
            on_error=on_owner_error,
        )
    )
    report.repos_listed = len(repos)
    rows: dict[str, list[dict]] = {name: [] for name in TABLES}
    rows["repos"] = [_repo_row(r, fetched) for r in repos]

    # star history first, so today's live values (below) win a same-day merge
    if settings.backfill_stars:
        done = {
            r["repo"]
            for r in read_table(store, TABLES["backfills"])
            if r["kind"] == "stars"
        }
        todo = [
            r["repo"]
            for r in repos
            if r["stars"] and r["can_push"] and r["repo"] not in done
        ]
        backfill = partial(star_history, graphql=graphql)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for repo, got, err in pool.map(lambda r: _safely(backfill, r), todo):
                if err is not None:
                    report.errors[repo] = f"star backfill: {err}"  # retried next run
                else:
                    rows["stars"] += got
                    rows["backfills"].append(
                        {"repo": repo, "kind": "stars", "date": fetched}
                    )
    rows["stars"] += [
        {"date": fetched, **{k: r[k] for k in ("repo", "stars", "forks", "watchers")}}
        for r in repos
    ]

    # traffic: only where the token can push
    readable = [r["repo"] for r in repos if r["can_push"]]
    report.no_access = sorted(r["repo"] for r in repos if not r["can_push"])
    last_snap = _last_snapshots(store, today)
    due = {
        repo: _snapshot_due(last_snap.get(repo), today, settings.snapshot_every_days)
        for repo in readable
    }

    def fetch(repo: str) -> dict[str, list[dict]]:
        got = fetch_daily(repo, rest=rest, fetched=fetched)
        if not due[repo]:
            got.pop("windows")
            return got
        return {**got, **fetch_popular(repo, rest=rest, fetched=fetched)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for repo, got, err in pool.map(lambda r: _safely(fetch, r), readable):
            if err is not None:
                if (
                    isinstance(err, GitHubError)
                    and err.status in NO_ACCESS_STATUSES
                    and not (err.is_rate_limit or err.is_policy_block)
                ):
                    report.no_access.append(repo)
                else:
                    report.errors[repo] = f"{type(err).__name__}: {err}"
                continue
            report.repos_collected += 1
            report.snapshots += bool(due[repo])
            for name, table_rows in got.items():
                rows[name] += table_rows
    report.no_access.sort()

    for name, spec in TABLES.items():
        if name != "runs" and rows[name]:
            report.files_changed += write_rows(store, spec, rows[name])

    report.duration_s = round(time.monotonic() - t0, 1)
    report.files_changed += write_rows(
        store,
        TABLES["runs"],
        [
            {
                "started_at": report.started_at,
                "duration_s": report.duration_s,
                "repos_listed": report.repos_listed,
                "repos_collected": report.repos_collected,
                "repos_no_access": len(report.no_access),
                "snapshots": report.snapshots,
                "errors": len(report.errors) + len(report.owner_errors),
            }
        ],
    )
    store[LAST_RUN_KEY] = json.dumps(asdict(report), indent=2) + "\n"
    write_manifest(store, updated=fetched)
    log(report.summary())
    return report


def has_private_data(store: MutableMapping) -> bool:
    """Whether the history holds anything about a private repo."""
    return any(r["private"] == "true" for r in read_table(store, TABLES["repos"]))


def window_days(store: MutableMapping) -> dict[str, int]:
    """How many distinct days each daily table holds (a quick health check)."""
    return {
        name: len({r["date"] for r in read_table(store, TABLES[name])})
        for name in ("views", "clones")
    }
