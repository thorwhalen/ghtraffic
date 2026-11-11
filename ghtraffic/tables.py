"""The schema of a ghtraffic data directory: which CSV tables, merged how.

:data:`TABLES` is the single source of truth the dashboard reads too (through
``manifest.json``). The machinery (``TableSpec``, the idempotent merge
policies, year partitions, the ``Files`` store) is the ``csvledger`` package,
re-exported here so ``from ghtraffic.tables import Files`` keeps working.

- ``views``, ``clones``: daily counts, merged by ``max``: a day's views only
  grow as the day completes, so the fullest count wins whichever run saw it.
- ``windows``, ``referrers``, ``paths``: 14-day snapshots, ``replace_group``
  per (fetch date, repo), so a same-day re-run leaves no stale rows.
- ``stars``: ``change_only`` per repo: stars and forks change rarely.
- ``repos``, ``backfills``, ``runs``: ``upsert``.
"""

from __future__ import annotations

from csvledger import (
    Files,
    MergePolicy,
    TableSpec,
    dump_csv,
    merge_rows,
    parse_csv,
    read_table,
    table_files,
    write_rows,
)

__all__ = [
    "Files",
    "MANIFEST_KEY",
    "MergePolicy",
    "SCHEMA_VERSION",
    "TABLES",
    "TableSpec",
    "dump_csv",
    "merge_rows",
    "parse_csv",
    "read_table",
    "table_files",
    "write_rows",
]

SCHEMA_VERSION = 1
MANIFEST_KEY = "manifest.json"

TABLES: dict[str, TableSpec] = {
    t.name: t
    for t in [
        TableSpec(
            "views",
            ("date", "repo", "count", "uniques"),
            key=("date", "repo"),
            merge="max",
            int_columns=("count", "uniques"),
            time_column="date",
            description="Daily page views per repo (days with zero views are absent).",
        ),
        TableSpec(
            "clones",
            ("date", "repo", "count", "uniques"),
            key=("date", "repo"),
            merge="max",
            int_columns=("count", "uniques"),
            time_column="date",
            description="Daily git clones per repo (days with zero clones are absent).",
        ),
        TableSpec(
            "windows",
            ("fetched", "repo", "kind", "count", "uniques"),
            key=("fetched", "repo", "kind"),
            merge="replace_group",
            group=("fetched", "repo"),
            int_columns=("count", "uniques"),
            time_column="fetched",
            description="14-day totals of views and clones at each snapshot; "
            "the only source of true 14-day unique visitors.",
        ),
        TableSpec(
            "referrers",
            ("fetched", "repo", "referrer", "count", "uniques"),
            key=("fetched", "repo", "referrer"),
            merge="replace_group",
            group=("fetched", "repo"),
            int_columns=("count", "uniques"),
            time_column="fetched",
            description="Top-10 referring sites over the 14 days before `fetched`.",
        ),
        TableSpec(
            "paths",
            ("fetched", "repo", "path", "title", "count", "uniques"),
            key=("fetched", "repo", "path"),
            merge="replace_group",
            group=("fetched", "repo"),
            int_columns=("count", "uniques"),
            time_column="fetched",
            description="Top-10 content paths over the 14 days before `fetched`.",
        ),
        TableSpec(
            "stars",
            ("date", "repo", "stars", "forks", "watchers"),
            key=("date", "repo"),
            merge="change_only",
            entity=("repo",),
            int_columns=("stars", "forks", "watchers"),
            description="Stars, forks and watchers, one row per change "
            "(backfilled star rows have empty forks and watchers).",
            sort=("repo", "date"),
        ),
        TableSpec(
            "backfills",
            ("repo", "kind", "date"),
            key=("repo", "kind"),
            merge="upsert",
            description="When each repo's history was backfilled (kind: stars), "
            "so a failed backfill is retried and a successful one is not repeated.",
        ),
        TableSpec(
            "repos",
            (
                "repo",
                "owner",
                "private",
                "fork",
                "archived",
                "can_push",
                "language",
                "created_at",
                "pushed_at",
                "description",
                "last_seen",
            ),
            key=("repo",),
            merge="upsert",
            description="Current metadata of every repo seen (kept after deletion).",
        ),
        TableSpec(
            "runs",
            (
                "started_at",
                "duration_s",
                "repos_listed",
                "repos_collected",
                "repos_no_access",
                "snapshots",
                "errors",
            ),
            key=("started_at",),
            merge="upsert",
            int_columns=(
                "repos_listed",
                "repos_collected",
                "repos_no_access",
                "snapshots",
                "errors",
            ),
            description="One row per collection run.",
        ),
    ]
}
