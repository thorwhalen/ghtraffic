"""Fetching one repo's traffic and turning API payloads into table rows.

GitHub keeps traffic for 14 days only. ``views`` and ``clones`` come as daily
series (plus window totals, whose ``uniques`` are *not* the sum of the daily
uniques), while ``popular/referrers`` and ``popular/paths`` are 14-day
aggregates with no daily breakdown, so those are stored as dated snapshots.

Functions here are pure translations (payload in, rows out) plus thin fetchers
that take a ``rest`` transport.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator, Mapping
from typing import Any

from ghtraffic.github import GraphQL, Rest

DAILY_KINDS = ("views", "clones")
SNAPSHOT_KINDS = ("referrers", "paths")


def daily_rows(repo: str, kind: str, payload: Mapping[str, Any]) -> list[dict]:
    """Rows ``{date, repo, count, uniques}`` from a views/clones payload.

    GitHub lists zero days explicitly; they are dropped (absence means zero),
    which keeps a mostly quiet fleet's files small.

    >>> daily_rows("a/b", "views", {"views": [
    ...     {"timestamp": "2026-11-01T00:00:00Z", "count": 5, "uniques": 2}]})
    [{'date': '2026-11-01', 'repo': 'a/b', 'count': 5, 'uniques': 2}]
    >>> daily_rows("a/b", "views", {"views": [
    ...     {"timestamp": "2026-11-01T00:00:00Z", "count": 0, "uniques": 0}]})
    []
    """
    return [
        {
            "date": d["timestamp"][:10],
            "repo": repo,
            "count": d["count"],
            "uniques": d["uniques"],
        }
        for d in payload.get(kind, [])
        if d["count"] or d["uniques"]
    ]


def window_row(
    repo: str, kind: str, payload: Mapping[str, Any], *, fetched: str
) -> dict:
    """The 14-day totals of a views/clones payload, as one snapshot row."""
    return {
        "fetched": fetched,
        "repo": repo,
        "kind": kind,
        "count": payload.get("count", 0),
        "uniques": payload.get("uniques", 0),
    }


def referrer_rows(repo: str, payload: list, *, fetched: str) -> list[dict]:
    """Snapshot rows from a ``popular/referrers`` payload."""
    return [
        {
            "fetched": fetched,
            "repo": repo,
            "referrer": r["referrer"],
            "count": r["count"],
            "uniques": r["uniques"],
        }
        for r in payload
    ]


def path_rows(repo: str, payload: list, *, fetched: str) -> list[dict]:
    """Snapshot rows from a ``popular/paths`` payload."""
    return [
        {
            "fetched": fetched,
            "repo": repo,
            "path": p["path"],
            "title": p.get("title", ""),
            "count": p["count"],
            "uniques": p["uniques"],
        }
        for p in payload
    ]


def fetch_repo_traffic(
    repo: str, *, rest: Rest, fetched: str, snapshot: bool = True
) -> dict[str, list[dict]]:
    """Fetch one repo's traffic as ``{table_name: rows}``.

    ``snapshot=False`` skips the two 14-day aggregate endpoints (referrers and
    paths) and the window totals, so a run that does not owe a snapshot costs
    two calls per repo instead of four.
    """
    base = f"/repos/{repo}/traffic"
    out: dict[str, list[dict]] = {"windows": []}
    for kind in DAILY_KINDS:
        payload = rest(f"{base}/{kind}?per=day")
        out[kind] = daily_rows(repo, kind, payload)
        if snapshot:
            out["windows"].append(window_row(repo, kind, payload, fetched=fetched))
    if snapshot:
        out["referrers"] = referrer_rows(
            repo, rest(f"{base}/popular/referrers"), fetched=fetched
        )
        out["paths"] = path_rows(repo, rest(f"{base}/popular/paths"), fetched=fetched)
    return out


STARGAZERS_QUERY = """
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $after, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt }
    }
  }
}
"""


def starred_dates(repo: str, *, graphql: GraphQL) -> Iterator[str]:
    """Yield the ``YYYY-MM-DD`` on which each current stargazer starred ``repo``."""
    owner, _, name = repo.partition("/")
    after = None
    while True:
        data = graphql(STARGAZERS_QUERY, {"owner": owner, "name": name, "after": after})
        conn = data["repository"]["stargazers"]
        yield from (e["starredAt"][:10] for e in conn["edges"])
        if not conn["pageInfo"]["hasNextPage"]:
            return
        after = conn["pageInfo"]["endCursor"]


def star_history_rows(repo: str, dates: list[str]) -> list[dict]:
    """Cumulative star counts per day from starring dates (one row per day).

    Only *current* stargazers are visible, so unstars are invisible and the
    history is a lower bound; forks and watchers stay empty in these rows.

    >>> star_history_rows("a/b", ["2026-01-02", "2026-01-01", "2026-01-02"])
    ... # doctest: +NORMALIZE_WHITESPACE
    [{'date': '2026-01-01', 'repo': 'a/b', 'stars': 1, 'forks': '', 'watchers': ''},
     {'date': '2026-01-02', 'repo': 'a/b', 'stars': 3, 'forks': '', 'watchers': ''}]
    """
    per_day = Counter(dates)
    rows, total = [], 0
    for day in sorted(per_day):
        total += per_day[day]
        rows.append(
            {"date": day, "repo": repo, "stars": total, "forks": "", "watchers": ""}
        )
    return rows
