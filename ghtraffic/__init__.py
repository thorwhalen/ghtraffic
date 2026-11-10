"""Accumulate GitHub traffic and insights across all your repos and orgs.

GitHub keeps repository traffic (views, clones, referrers, popular paths) for
14 days only. ``ghtraffic`` collects it on a schedule and merges it into a
growing, git-friendly history of CSV files, together with star, fork and
watcher counts, and ships a static dashboard to explore it.

>>> from ghtraffic import collect, load_settings, Files   # doctest: +SKIP
>>> collect(load_settings(owners=["@me"]), store=Files("~/traffic"))  # doctest: +SKIP

Main pieces:

- :func:`collect`: one idempotent run (cold start and update are the same call).
- :func:`load_settings` / :class:`Settings`: which owners and repos.
- :data:`TABLES`: the on-disk schema; :class:`Files`: the default store.
- :func:`init_data_repo`: write the workflow + config into a data repository.
"""

from ghtraffic.collect import RunReport, collect, write_manifest
from ghtraffic.config import Settings, load_settings
from ghtraffic.github import GitHubError, make_graphql, make_rest, resolve_token
from ghtraffic.repos import list_repos
from ghtraffic.scaffold import init_data_repo
from ghtraffic.tables import TABLES, Files, TableSpec, merge_rows, read_table

__all__ = [
    "Files",
    "GitHubError",
    "RunReport",
    "Settings",
    "TABLES",
    "TableSpec",
    "collect",
    "init_data_repo",
    "list_repos",
    "load_settings",
    "make_graphql",
    "make_rest",
    "merge_rows",
    "read_table",
    "resolve_token",
    "write_manifest",
]
