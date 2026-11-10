"""Collection settings: which owners, which repos, how often to snapshot.

Settings come from a TOML file (``ghtraffic.toml`` at the data directory's root
by default), under a ``[ghtraffic]`` table or at top level, overridden by
keyword arguments. Every field has a default, so an empty file (or none)
collects every repo of the authenticated user and their organizations.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, replace
from pathlib import Path

import tomllib

DFLT_CONFIG_FILENAME = "ghtraffic.toml"
DFLT_DATA_DIR = (
    Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    / "ghtraffic"
    / "data"
)


@dataclass(frozen=True)
class Settings:
    """What to collect, and how.

    Attributes:
        owners: user/org logins; ``"@me"`` means you and every org you belong to.
        exclude: ``owner/repo`` fnmatch patterns to skip (``"acme/*"`` skips an owner).
        include_forks: collect forks too.
        include_archived: collect archived repos too.
        snapshot_every_days: days between snapshots of the 14-day aggregates
            (referrers, paths, window totals). 14 (the default) tiles the window:
            snapshots never overlap, so their counts can be added up.
        backfill_stars: on first sight of a repo, rebuild its star history from
            stargazer dates (one GraphQL call per 100 stars).
        max_workers: concurrent requests while fetching traffic.
    """

    owners: tuple[str, ...] = ("@me",)
    exclude: tuple[str, ...] = ()
    include_forks: bool = True
    include_archived: bool = True
    snapshot_every_days: int = 14
    backfill_stars: bool = True
    max_workers: int = 8
    extra: dict = field(default_factory=dict, compare=False)


def _from_mapping(d: dict) -> Settings:
    d = dict(d.get("ghtraffic", d))
    known = {f.name for f in fields(Settings)} - {"extra"}
    kwargs = {k: d.pop(k) for k in list(d) if k in known}
    for k in ("owners", "exclude"):
        if k in kwargs:
            v = kwargs[k]
            kwargs[k] = (v,) if isinstance(v, str) else tuple(v)
    return Settings(**kwargs, extra=d)


def load_settings(path: str | os.PathLike | None = None, **overrides) -> Settings:
    """Settings from a TOML file (missing file: defaults), then ``overrides``."""
    s = Settings()
    if path is not None and Path(path).exists():
        s = _from_mapping(tomllib.loads(Path(path).read_text(encoding="utf-8")))
    overrides = {k: v for k, v in overrides.items() if v is not None}
    for k in ("owners", "exclude"):
        if isinstance(overrides.get(k), str):
            overrides[k] = (overrides[k],)
        elif k in overrides:
            overrides[k] = tuple(overrides[k])
    return replace(s, **overrides)
