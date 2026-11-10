"""Enumerating the repositories to collect: owners in, repo records out.

An *owner* is a user or organization login, or ``"@me"``, which expands to the
authenticated user and every organization they belong to. One GraphQL page
returns up to 100 repos with everything the collector needs to decide whether
traffic is readable (``viewerPermission``) and to snapshot stars and forks, so
a whole organization costs a handful of calls.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping
from fnmatch import fnmatch
from typing import Any

from ghtraffic.github import GitHubError, GraphQL, Rest

ME = "@me"
DFLT_PAGE_SIZE = 100
#: ``viewerPermission`` values that grant push access, which traffic needs.
PUSH_PERMISSIONS = frozenset({"ADMIN", "MAINTAIN", "WRITE"})

REPOS_QUERY = """
query($owner: String!, $after: String, $n: Int!) {
  repositoryOwner(login: $owner) {
    repositories(first: $n, after: $after, ownerAffiliations: OWNER) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner isPrivate isFork isArchived viewerPermission
        stargazerCount forkCount watchers { totalCount }
        createdAt pushedAt primaryLanguage { name } description
      }
    }
  }
}
"""


def my_owners(rest: Rest) -> list[str]:
    """The authenticated user's login followed by their organizations' logins."""
    return [rest("/user")["login"]] + [
        o["login"] for o in rest("/user/orgs?per_page=100")
    ]


def expand_owners(owners: Iterable[str], *, me: Callable[[], list[str]]) -> list[str]:
    """Replace ``"@me"`` by the user's owners; keep order, drop duplicates.

    >>> expand_owners(["@me", "acme", "bob"], me=lambda: ["bob", "org1"])
    ['bob', 'org1', 'acme']
    """
    out: list[str] = []
    for owner in owners:
        for item in me() if owner == ME else [owner]:
            if item.lower() not in (o.lower() for o in out):
                out.append(item)
    return out


def is_excluded(repo: str, exclude: Iterable[str]) -> bool:
    """Whether ``owner/name`` matches any (case-insensitive) fnmatch pattern.

    >>> is_excluded("Acme/x", ["acme/*"]), is_excluded("bob/x", ["acme/*"])
    (True, False)
    """
    r = repo.lower()
    return any(fnmatch(r, p.lower()) for p in exclude)


def normalize_repo(node: Mapping[str, Any]) -> dict:
    """Flatten one GraphQL repository node into a flat record.

    >>> r = normalize_repo({"nameWithOwner": "a/b", "viewerPermission": "WRITE",
    ...     "watchers": {"totalCount": 3}, "primaryLanguage": None})
    >>> r["repo"], r["owner"], r["can_push"], r["watchers"], r["language"]
    ('a/b', 'a', True, 3, '')
    """
    owner, _, _ = node["nameWithOwner"].partition("/")
    return {
        "repo": node["nameWithOwner"],
        "owner": owner,
        "private": bool(node.get("isPrivate")),
        "fork": bool(node.get("isFork")),
        "archived": bool(node.get("isArchived")),
        "can_push": node.get("viewerPermission") in PUSH_PERMISSIONS,
        "stars": node.get("stargazerCount") or 0,
        "forks": node.get("forkCount") or 0,
        "watchers": (node.get("watchers") or {}).get("totalCount") or 0,
        "created_at": node.get("createdAt") or "",
        "pushed_at": node.get("pushedAt") or "",
        "language": (node.get("primaryLanguage") or {}).get("name") or "",
        "description": node.get("description") or "",
    }


def owner_repos(
    owner: str, *, graphql: GraphQL, page_size: int = DFLT_PAGE_SIZE
) -> Iterator[dict]:
    """Yield normalized records for every repo owned by ``owner``."""
    after = None
    while True:
        data = graphql(REPOS_QUERY, {"owner": owner, "after": after, "n": page_size})
        conn = ((data or {}).get("repositoryOwner") or {}).get("repositories")
        if not conn:
            raise GitHubError(404, f"owner {owner!r} not found or not visible")
        yield from (normalize_repo(n) for n in conn["nodes"] if n)
        if not conn["pageInfo"]["hasNextPage"]:
            return
        after = conn["pageInfo"]["endCursor"]


def list_repos(
    owners: Iterable[str],
    *,
    graphql: GraphQL,
    rest: Rest | None = None,
    exclude: Iterable[str] = (),
    include_forks: bool = True,
    include_archived: bool = True,
    on_error: Callable[[str, Exception], None] | None = None,
) -> Iterator[dict]:
    """Yield repo records over all ``owners``, filtered by the inclusion rules.

    An owner whose listing fails goes to ``on_error(owner, error)`` and is
    skipped; with ``on_error=None`` the error propagates. ``rest`` is only
    needed to expand ``"@me"``.
    """
    exclude = list(exclude)

    def me() -> list[str]:
        if rest is None:
            raise ValueError('Expanding "@me" needs a `rest` transport.')
        return my_owners(rest)

    for owner in expand_owners(owners, me=me):
        if is_excluded(f"{owner}/*", exclude):
            continue
        try:
            for rec in owner_repos(owner, graphql=graphql):
                if is_excluded(rec["repo"], exclude):
                    continue
                if (rec["fork"] and not include_forks) or (
                    rec["archived"] and not include_archived
                ):
                    continue
                yield rec
        except GitHubError as e:
            if on_error is None:
                raise
            on_error(owner, e)
