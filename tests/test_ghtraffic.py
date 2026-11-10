"""End-to-end tests of a collection run against a fake GitHub."""

import json
from datetime import datetime, timezone

import pytest

from ghtraffic import TABLES, Files, GitHubError, collect, load_settings, read_table
from ghtraffic.__main__ import main
from ghtraffic.scaffold import WORKFLOW_PATH, init_data_repo


def _node(name, *, perm="WRITE", stars=0, private=False, fork=False):
    return {
        "nameWithOwner": name,
        "isPrivate": private,
        "isFork": fork,
        "isArchived": False,
        "viewerPermission": perm,
        "stargazerCount": stars,
        "forkCount": 1,
        "watchers": {"totalCount": 2},
        "createdAt": "2020-01-01T00:00:00Z",
        "pushedAt": "2026-11-01T00:00:00Z",
        "primaryLanguage": {"name": "Python"},
        "description": "d",
    }


class FakeGitHub:
    """Serves a fixed world; ``days`` is the 14-day window currently visible."""

    def __init__(self, days, *, views=3, forbidden=(), sso=(), star_fail=None):
        self.days, self.views, self.forbidden = days, views, set(forbidden)
        self.sso, self.star_fail = set(sso), star_fail
        self.calls = []
        self.nodes = {
            "me": [_node("me/a", stars=2), _node("me/b", perm="READ")],
            "org": [_node("org/c", private=True), _node("org/fork", fork=True)],
        }

    def rest(self, path):
        self.calls.append(path)
        if path == "/user":
            return {"login": "me"}
        if path.startswith("/user/orgs"):
            return [{"login": "org"}]
        repo = "/".join(path.split("/")[2:4])
        if repo in self.forbidden:
            raise GitHubError(403, "Must have push access to repository", path=path)
        if repo in self.sso:
            raise GitHubError(
                403, "Resource protected by organization SAML enforcement", path=path
            )
        kind = path.split("/traffic/")[1].split("?")[0]
        if kind in ("views", "clones"):
            series = [
                {"timestamp": f"{d}T00:00:00Z", "count": self.views, "uniques": 1}
                for d in self.days
            ]
            return {"count": self.views * len(series), "uniques": 2, kind: series}
        if kind == "popular/referrers":
            return [{"referrer": "google.com", "count": 4, "uniques": 2}]
        if kind == "popular/paths":
            return [
                {"path": f"/{repo}", "title": "t, with comma", "count": 4, "uniques": 2}
            ]
        raise AssertionError(path)

    def graphql(self, query, variables):
        if "stargazers" in query:
            if self.star_fail == "null":
                return {"repository": None}
            if self.star_fail == "502":
                raise GitHubError(502, "Bad gateway")
            return {
                "repository": {
                    "stargazers": {
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "edges": [
                            {"starredAt": "2025-03-01T10:00:00Z"},
                            {"starredAt": "2025-06-01T10:00:00Z"},
                        ],
                    }
                }
            }
        nodes = self.nodes.get(variables["owner"])
        if nodes is None:
            return {"repositoryOwner": None}
        return {
            "repositoryOwner": {
                "repositories": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": nodes,
                }
            }
        }


def _days(start, n):
    from datetime import date, timedelta

    d0 = date.fromisoformat(start)
    return [(d0 + timedelta(i)).isoformat() for i in range(n)]


def _run(store, gh, when, **settings):
    return collect(
        load_settings(**settings),
        store=store,
        rest=gh.rest,
        graphql=gh.graphql,
        now=lambda: datetime.fromisoformat(when).replace(tzinfo=timezone.utc),
        log=lambda s: None,
    )


def test_cold_start_then_update_is_idempotent(tmp_path):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2026-10-27", 14))
    r = _run(store, gh, "2026-11-10T03:17:00")

    assert r.repos_listed == 4
    assert r.no_access == ["me/b"]  # READ permission: skipped, not an error
    assert r.repos_collected == 3 and not r.errors
    views = read_table(store, TABLES["views"])
    assert len(views) == 3 * 14
    assert {v["repo"] for v in views} == {"me/a", "org/c", "org/fork"}

    snapshot = {k: store[k] for k in store if k.endswith(".csv")}
    _run(store, gh, "2026-11-10T09:00:00")  # same day, same data
    assert {k: store[k] for k in store if k.endswith(".csv") and k != "runs.csv"} == {
        k: v for k, v in snapshot.items() if k != "runs.csv"
    }

    # next day: window slides by one, today's partial count grew
    gh.days, gh.views = _days("2026-10-28", 14), 5
    _run(store, gh, "2026-11-11T03:17:00")
    views = read_table(store, TABLES["views"])
    assert len({v["date"] for v in views}) == 15  # history accumulates
    oldest = [v for v in views if v["date"] == "2026-10-27"]
    assert all(v["count"] == 3 for v in oldest)  # outside the window: kept
    newest = [v for v in views if v["date"] == "2026-11-10"]
    assert all(v["count"] == 5 for v in newest)  # max wins


def test_snapshots_follow_cadence(tmp_path):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2026-10-27", 14))
    assert _run(store, gh, "2026-11-10T03:00:00").snapshots == 3
    gh.calls.clear()
    assert _run(store, gh, "2026-11-12T03:00:00").snapshots == 0
    assert not any("popular" in c for c in gh.calls)  # 2 calls per repo, not 4
    assert _run(store, gh, "2026-11-23T03:00:00").snapshots == 0
    assert _run(store, gh, "2026-11-24T03:00:00").snapshots == 3
    refs = read_table(store, TABLES["referrers"])
    assert sorted({r["fetched"] for r in refs}) == ["2026-11-10", "2026-11-24"]
    paths = read_table(store, TABLES["paths"])
    assert paths[0]["title"] == "t, with comma"  # CSV quoting round-trips


def test_forbidden_repo_is_reported_not_failed(tmp_path):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2026-10-27", 14), forbidden={"org/c"})
    r = _run(store, gh, "2026-11-10T03:00:00")
    assert "org/c" in r.no_access and not r.errors
    last = json.loads(store["last_run.json"])
    assert "org/c" in last["no_access"]


def test_unknown_owner_is_reported(tmp_path):
    gh = FakeGitHub(_days("2026-10-27", 14))
    r = _run(Files(tmp_path), gh, "2026-11-10T03:00:00", owners=["me", "ghost"])
    assert "ghost" in r.owner_errors and r.repos_listed == 2


def test_exclusions_and_forks(tmp_path):
    gh = FakeGitHub(_days("2026-10-27", 14))
    r = _run(
        Files(tmp_path),
        gh,
        "2026-11-10T03:00:00",
        owners=["@me"],
        exclude=["org/c"],
        include_forks=False,
    )
    assert r.repos_listed == 2  # me/a, me/b


def test_stars_backfill_and_change_only(tmp_path):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2026-10-27", 14))
    _run(store, gh, "2026-11-10T03:00:00")
    stars = [s for s in read_table(store, TABLES["stars"]) if s["repo"] == "me/a"]
    assert [(s["date"], s["stars"]) for s in stars] == [
        ("2025-03-01", 1),
        ("2025-06-01", 2),
        ("2026-11-10", 2),  # forks/watchers now known: a change
    ]
    _run(store, gh, "2026-11-11T03:00:00")  # nothing changed: no new row
    assert (
        len([s for s in read_table(store, TABLES["stars"]) if s["repo"] == "me/a"]) == 3
    )
    gh.nodes["me"][0]["stargazerCount"] = 3
    _run(store, gh, "2026-11-12T03:00:00")
    assert (
        len([s for s in read_table(store, TABLES["stars"]) if s["repo"] == "me/a"]) == 4
    )


def test_manifest_lists_partitions(tmp_path):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2025-12-25", 14))  # spans two years
    _run(store, gh, "2026-01-07T03:00:00")
    m = json.loads(store["manifest.json"])
    assert m["tables"]["views"]["files"] == ["views/2025.csv", "views/2026.csv"]
    assert m["tables"]["repos"]["files"] == ["repos.csv"]


def test_init_and_cli(tmp_path, monkeypatch):
    written = init_data_repo(tmp_path, owners=["me", "org"])
    assert WORKFLOW_PATH in written
    wf = (tmp_path / WORKFLOW_PATH).read_text()
    assert "${{ secrets.GHTRAFFIC_TOKEN }}" in wf and "thorwhalen/ghtraffic@" in wf
    s = load_settings(tmp_path / "ghtraffic.toml")
    assert s.owners == ("me", "org") and s.snapshot_every_days == 14
    assert init_data_repo(tmp_path) == []  # never overwrites by default
    assert main(["init", str(tmp_path / "x")]) == 0


def test_rate_limit_is_an_error_not_no_access():
    assert GitHubError(403, "API rate limit exceeded").is_rate_limit
    assert not GitHubError(403, "Must have push access").is_rate_limit


@pytest.mark.parametrize("name", list(TABLES))
def test_every_table_round_trips_empty(name):
    from ghtraffic.tables import dump_csv, parse_csv

    spec = TABLES[name]
    assert parse_csv(spec, dump_csv(spec, [])) == []


def test_dashboard_schema_matches_tables():
    """The dashboard's TABLE_COLUMNS must equal the Python schema (SSOT)."""
    import re
    from pathlib import Path

    ts = (Path(__file__).parents[1] / "dashboard/src/schema.ts").read_text()
    m = re.search(r"export const TABLE_COLUMNS = (\{.*?\}) as const;", ts, re.S)
    assert m, "TABLE_COLUMNS constant not found in dashboard/src/schema.ts"
    assert json.loads(m.group(1)) == {k: list(v.columns) for k, v in TABLES.items()}


def test_policy_block_is_an_error_not_no_access(tmp_path):
    gh = FakeGitHub(_days("2026-10-27", 14), sso={"org/c"})
    r = _run(Files(tmp_path), gh, "2026-11-10T03:00:00")
    assert "org/c" not in r.no_access and "org/c" in r.errors


@pytest.mark.parametrize("failure", ["null", "502"])
def test_failed_star_backfill_never_sinks_the_run_and_is_retried(tmp_path, failure):
    store = Files(tmp_path)
    gh = FakeGitHub(_days("2026-10-27", 14), star_fail=failure)
    r = _run(store, gh, "2026-11-10T03:00:00")
    assert "me/a" in r.errors and r.repos_collected == 3  # traffic still written
    gh.star_fail = None
    _run(store, gh, "2026-11-11T03:00:00")
    stars = [s for s in read_table(store, TABLES["stars"]) if s["repo"] == "me/a"]
    assert [s["date"] for s in stars][:2] == ["2025-03-01", "2025-06-01"]
    gh.calls.clear()
    _run(store, gh, "2026-11-12T03:00:00")  # done once: not repeated


def test_worker_exception_is_recorded_per_repo(tmp_path):
    gh = FakeGitHub(_days("2026-10-27", 14))
    orig = gh.rest

    def rest(path):
        if path.startswith("/repos/org/c/"):
            raise ValueError("garbage body")
        return orig(path)

    gh.rest = rest
    r = _run(Files(tmp_path), gh, "2026-11-10T03:00:00")
    assert "ValueError" in r.errors["org/c"] and r.repos_collected == 2


def test_change_only_same_day_merges_fieldwise_and_stays_minimal():
    from ghtraffic.tables import merge_rows

    spec = TABLES["stars"]
    live = {"date": "2026-11-10", "repo": "a/b", "stars": 3, "forks": 1, "watchers": 2}
    backfill = {
        "date": "2026-11-10",
        "repo": "a/b",
        "stars": 3,
        "forks": "",
        "watchers": "",
    }
    assert merge_rows(spec, [], [backfill, live]) == [live]
    assert merge_rows(spec, [], [live, backfill]) == [live]  # empty never erases
    day2 = {**live, "date": "2026-11-11"}
    assert merge_rows(spec, [live], [day2]) == [live]  # unchanged: no row
    early = {**live, "date": "2026-11-01"}
    assert merge_rows(spec, [live], [early]) == [early]  # later equal row dropped


def test_unknown_setting_is_refused(tmp_path):
    (tmp_path / "ghtraffic.toml").write_text("[ghtraffic]\nsnapshot_every_day = 7\n")
    with pytest.raises(ValueError, match="snapshot_every_day"):
        load_settings(tmp_path / "ghtraffic.toml")


def test_graphql_partial_errors_are_raised(monkeypatch):
    from ghtraffic import github

    payload = {
        "data": {"x": 1},
        "errors": [{"type": "RATE_LIMITED", "message": "slow"}],
    }
    monkeypatch.setattr(github, "_request", lambda *a, **k: payload)
    with pytest.raises(GitHubError) as e:
        github.make_graphql("tok")("query", {})
    assert e.value.is_rate_limit


def test_guard_refuses_private_data_in_public_repo(tmp_path, monkeypatch):
    from ghtraffic import __main__ as cli
    from ghtraffic import github

    store = Files(tmp_path)
    _run(store, FakeGitHub(_days("2026-10-27", 14)), "2026-11-10T03:00:00")
    monkeypatch.setattr(github, "make_rest", lambda: lambda path: {"private": False})
    assert cli.main(["guard", "--data-dir", str(tmp_path), "--repo", "x/y"]) == 1
    monkeypatch.setattr(github, "make_rest", lambda: lambda path: {"private": True})
    assert cli.main(["guard", "--data-dir", str(tmp_path), "--repo", "x/y"]) == 0


def test_cli_exposes_every_setting():
    from dataclasses import fields

    from ghtraffic.__main__ import _parser
    from ghtraffic.config import Settings

    args = _parser().parse_args(
        ["collect", "--no-include-forks", "--snapshot-every-days", "3"]
    )
    assert args.include_forks is False and args.snapshot_every_days == 3
    assert all(hasattr(args, f.name) for f in fields(Settings))


def test_demo_is_a_complete_data_dir(tmp_path):
    from ghtraffic.demo import make_demo_data

    m = make_demo_data(Files(tmp_path), n_days=30)
    assert (tmp_path / "last_run.json").exists()
    assert all(m["tables"][t]["files"] for t in ("views", "clones", "stars", "repos"))
