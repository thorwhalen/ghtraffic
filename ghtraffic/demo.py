"""A synthetic data directory, for the public demo dashboard and for tests.

Nothing here comes from GitHub: owners and repos are invented, and the series
are drawn from a seeded random generator (weekly seasonality, slow growth, a
few launch spikes), so the demo can be published without leaking anything.
The rows go through the same :func:`~ghtraffic.tables.write_rows` merge as a
real collection, so the demo exercises the real on-disk format.
"""

from __future__ import annotations

import math
import random
from collections.abc import MutableMapping
from datetime import date, timedelta

from ghtraffic.collect import write_manifest
from ghtraffic.tables import TABLES, write_rows

DEMO_REPOS = {
    "acme": ["rocket", "anvil", "roadrunner-sdk", "blueprints", "legacy-tools"],
    "acme-labs": ["quantum-toast", "dataflow", "notebooks"],
    "wile": ["dotfiles", "trap-designer", "blog"],
}
DEMO_REFERRERS = [
    "github.com",
    "google.com",
    "news.ycombinator.com",
    "reddit.com",
    "pypi.org",
    "duckduckgo.com",
    "t.co",
    "bing.com",
]
DEMO_PAGES = [
    "",
    "/issues",
    "/pulls",
    "/blob/main/README.md",
    "/releases",
    "/actions",
    "/wiki",
    "/tree/main/docs",
]


def _series(rng: random.Random, n_days: int, *, base: float, growth: float):
    spikes = {
        rng.randrange(n_days): rng.uniform(4, 15) for _ in range(rng.randint(0, 3))
    }
    for i in range(n_days):
        weekday = 0.6 if (i % 7) in (5, 6) else 1.0
        level = base * math.exp(growth * i / n_days) * weekday
        level *= spikes.get(i, 1.0)
        for j in range(1, 4):  # spikes decay over a few days
            level *= 1 + (spikes.get(i - j, 1.0) - 1) / (2 ** (j + 1))
        yield max(0, int(rng.gauss(level, level**0.5 + 0.5)))


def make_demo_data(
    store: MutableMapping,
    *,
    today: date | None = None,
    n_days: int = 420,
    seed: int = 7,
    snapshot_every_days: int = 14,
) -> dict:
    """Fill ``store`` with a synthetic history ending ``today``; return the manifest."""
    rng = random.Random(seed)
    today = today or date.today()
    days = [today - timedelta(n_days - 1 - i) for i in range(n_days)]
    rows: dict[str, list[dict]] = {name: [] for name in TABLES}
    for owner, names in DEMO_REPOS.items():
        for name in names:
            repo = f"{owner}/{name}"
            popularity = rng.choice([0.3, 1, 3, 10, 40])
            growth = rng.uniform(-0.5, 1.5)
            views = list(_series(rng, n_days, base=popularity * 6, growth=growth))
            clones = list(_series(rng, n_days, base=popularity * 1.5, growth=growth))
            for d, v, c in zip(days, views, clones):
                if v:
                    rows["views"].append(
                        {
                            "date": d.isoformat(),
                            "repo": repo,
                            "count": v,
                            "uniques": max(1, v // 3),
                        }
                    )
                if c:
                    rows["clones"].append(
                        {
                            "date": d.isoformat(),
                            "repo": repo,
                            "count": c,
                            "uniques": max(1, c // 2),
                        }
                    )
            for k in range(0, n_days, snapshot_every_days):
                snap = days[k].isoformat()
                window_v, window_c = (
                    views[max(0, k - 13) : k + 1],
                    clones[max(0, k - 13) : k + 1],
                )
                for kind, w in (("views", window_v), ("clones", window_c)):
                    rows["windows"].append(
                        {
                            "fetched": snap,
                            "repo": repo,
                            "kind": kind,
                            "count": sum(w),
                            "uniques": max(1, sum(w) // 4),
                        }
                    )
                total = sum(window_v)
                if not total:
                    continue
                for ref in rng.sample(DEMO_REFERRERS, rng.randint(1, 6)):
                    cnt = max(1, int(total * rng.uniform(0.02, 0.4)))
                    rows["referrers"].append(
                        {
                            "fetched": snap,
                            "repo": repo,
                            "referrer": ref,
                            "count": cnt,
                            "uniques": max(1, cnt // 2),
                        }
                    )
                for page in rng.sample(DEMO_PAGES, rng.randint(1, 6)):
                    cnt = max(1, int(total * rng.uniform(0.02, 0.5)))
                    rows["paths"].append(
                        {
                            "fetched": snap,
                            "repo": repo,
                            "path": f"/{repo}{page}",
                            "title": f"{repo}{page}",
                            "count": cnt,
                            "uniques": max(1, cnt // 2),
                        }
                    )
            stars = forks = 0
            for d in days:
                if rng.random() < popularity / 60:
                    stars += rng.randint(1, 3)
                    forks += rng.random() < 0.2
                    rows["stars"].append(
                        {
                            "date": d.isoformat(),
                            "repo": repo,
                            "stars": stars,
                            "forks": forks,
                            "watchers": 1 + stars // 10,
                        }
                    )
            rows["repos"].append(
                {
                    "repo": repo,
                    "owner": owner,
                    "private": owner == "wile" and name != "blog",
                    "fork": False,
                    "archived": name == "legacy-tools",
                    "can_push": True,
                    "language": rng.choice(
                        ["Python", "TypeScript", "Rust", "Jupyter Notebook"]
                    ),
                    "created_at": days[0].isoformat() + "T00:00:00Z",
                    "pushed_at": today.isoformat() + "T00:00:00Z",
                    "description": f"Demo repository {name}",
                    "last_seen": today.isoformat(),
                }
            )
    rows["runs"] = [
        {
            "started_at": f"{today.isoformat()}T03:17:00+00:00",
            "duration_s": 12.3,
            "repos_listed": len(rows["repos"]),
            "repos_collected": len(rows["repos"]),
            "repos_no_access": 0,
            "snapshots": len(rows["repos"]),
            "errors": 0,
        }
    ]
    for name, spec in TABLES.items():
        write_rows(store, spec, rows[name])
    return write_manifest(store, updated=today.isoformat())
