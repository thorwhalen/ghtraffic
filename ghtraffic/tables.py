"""The history store: CSV tables, partitioned by year, merged idempotently.

A table is described by a :class:`TableSpec` (columns, key, merge policy,
partitioning); :data:`TABLES` is the schema of a ghtraffic data directory, the
single source of truth the dashboard reads too (through ``manifest.json``).

The bytes live behind a ``MutableMapping[str, str]`` (relative path to text),
so a data directory can be a local folder (:class:`Files`, the default), a git
checkout, or any ``dol`` store, without touching the merge logic.

Merge policies, chosen so that re-running a collection never changes the
result (idempotent) and the order of runs does not matter for daily series:

- ``max``: upsert by key; numeric fields keep the larger value. A day's views
  only grow as the day completes, so the latest, fullest count wins whichever
  run saw it.
- ``replace_group``: rows of a snapshot (one repo, one fetch date) replace any
  earlier rows of the same group, so a same-day re-run leaves no stale rows.
- ``change_only``: a row is stored only when its values differ from the
  repo's previous row (stars and forks change rarely; daily copies would be
  noise).
- ``upsert``: upsert by key, the new row wins (current repo metadata).
"""

from __future__ import annotations

import csv
import io
import os
from collections.abc import Iterable, Iterator, MutableMapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

SCHEMA_VERSION = 1
MergePolicy = Literal["max", "replace_group", "change_only", "upsert"]
MANIFEST_KEY = "manifest.json"


@dataclass(frozen=True)
class TableSpec:
    """How one table is laid out on disk and merged."""

    name: str
    columns: tuple[str, ...]
    key: tuple[str, ...]
    merge: MergePolicy
    int_columns: tuple[str, ...] = ()
    time_column: str | None = None  # partition by its year when set
    group: tuple[str, ...] = ()  # for 'replace_group'
    description: str = ""
    sort: tuple[str, ...] = field(default=())

    def __post_init__(self):
        if self.merge == "change_only" and self.time_column is not None:
            raise ValueError("A 'change_only' table cannot be partitioned by time.")

    @property
    def sort_columns(self) -> tuple[str, ...]:
        """Sort order on disk: time first, so new rows land at the end of a file."""
        return self.sort or self.key

    def path_for(self, row: dict) -> str:
        """The relative path of the file holding ``row``."""
        if self.time_column is None:
            return f"{self.name}.csv"
        return f"{self.name}/{str(row[self.time_column])[:4]}.csv"


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


# --------------------------------------------------------------------------- store


class Files(MutableMapping):
    """Text files under ``rootdir``, keyed by relative POSIX path."""

    def __init__(self, rootdir: str | os.PathLike):
        self.rootdir = Path(rootdir).expanduser()

    def _path(self, k: str) -> Path:
        return self.rootdir / k

    def __getitem__(self, k: str) -> str:
        try:
            return self._path(k).read_text(encoding="utf-8")
        except FileNotFoundError:
            raise KeyError(k) from None

    def __setitem__(self, k: str, v: str) -> None:
        p = self._path(k)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(v, encoding="utf-8", newline="\n")
        os.replace(tmp, p)  # atomic: a crash never leaves half a file

    def __delitem__(self, k: str) -> None:
        try:
            self._path(k).unlink()
        except FileNotFoundError:
            raise KeyError(k) from None

    def __iter__(self) -> Iterator[str]:
        if not self.rootdir.exists():
            return
        for p in sorted(self.rootdir.rglob("*")):
            if p.is_file() and ".git" not in p.parts:
                yield p.relative_to(self.rootdir).as_posix()

    def __len__(self) -> int:
        return sum(1 for _ in self)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self.rootdir)!r})"


# ------------------------------------------------------------------ csv in and out


def _coerce(spec: TableSpec, row: dict) -> dict:
    out = {c: row.get(c, "") for c in spec.columns}
    for c in spec.int_columns:
        v = out[c]
        out[c] = int(v) if v not in ("", None) else ""
    for c, v in out.items():
        if isinstance(v, bool):
            out[c] = "true" if v else "false"
    return out


def parse_csv(spec: TableSpec, text: str) -> list[dict]:
    """Rows of a table file, with integer columns as ``int``."""
    return [_coerce(spec, r) for r in csv.DictReader(io.StringIO(text))]


def _sort_key(spec: TableSpec):
    return lambda r: tuple(str(r[c]) for c in spec.sort_columns)


def dump_csv(spec: TableSpec, rows: Iterable[dict]) -> str:
    """CSV text of ``rows``, sorted by the spec's sort columns, ``\\n`` line ends."""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=spec.columns, lineterminator="\n")
    w.writeheader()
    w.writerows(sorted((_coerce(spec, r) for r in rows), key=_sort_key(spec)))
    return buf.getvalue()


# -------------------------------------------------------------------------- merging


def _values(spec: TableSpec, row: dict) -> tuple:
    return tuple(row[c] for c in spec.columns if c not in spec.key)


def merge_rows(spec: TableSpec, old: list[dict], new: list[dict]) -> list[dict]:
    """Merge ``new`` rows into ``old`` according to ``spec.merge``.

    >>> v = TABLES["views"]
    >>> old = [{"date": "2026-01-01", "repo": "a/b", "count": 3, "uniques": 1}]
    >>> new = [{"date": "2026-01-01", "repo": "a/b", "count": 5, "uniques": 1},
    ...        {"date": "2026-01-02", "repo": "a/b", "count": 1, "uniques": 1}]
    >>> [r["count"] for r in merge_rows(v, old, new)]
    [5, 1]
    >>> merge_rows(v, merge_rows(v, old, new), new) == merge_rows(v, old, new)
    True
    """
    old = [_coerce(spec, r) for r in old]
    new = [_coerce(spec, r) for r in new]

    def key(r):
        return tuple(str(r[c]) for c in spec.key)

    if spec.merge in ("max", "upsert"):
        merged = {key(r): r for r in old}
        for r in new:
            k = key(r)
            if spec.merge == "max" and k in merged:
                prev = merged[k]
                r = {
                    c: (
                        max(prev[c], r[c])
                        if c in spec.int_columns and prev[c] != "" and r[c] != ""
                        else r[c]
                        if r[c] != ""
                        else prev[c]
                    )
                    for c in spec.columns
                }
            merged[k] = r
        return list(merged.values())

    if spec.merge == "replace_group":
        groups = {tuple(str(r[c]) for c in spec.group) for r in new}
        kept = [r for r in old if tuple(str(r[c]) for c in spec.group) not in groups]
        return kept + new

    if spec.merge == "change_only":
        merged: dict[tuple, dict] = {}
        for r in old + new:  # same key: field-wise, a non-empty newer value wins
            prev = merged.get(key(r), {})
            merged[key(r)] = {
                c: r[c] if r[c] != "" else prev.get(c, "") for c in spec.columns
            }
        kept, last_values = [], {}
        for r in sorted(merged.values(), key=lambda r: (r["repo"], str(r["date"]))):
            if last_values.get(r["repo"]) != _values(spec, r):
                kept.append(r)
                last_values[r["repo"]] = _values(spec, r)
        return kept

    raise ValueError(f"Unknown merge policy {spec.merge!r} for table {spec.name!r}")


def read_table(
    store: MutableMapping, spec: TableSpec, *, years: Iterable[str] | None = None
) -> list[dict]:
    """All rows of a table (optionally only some year partitions)."""
    keys = table_files(store, spec)
    if years is not None:
        wanted = {f"{spec.name}/{y}.csv" for y in years}
        keys = [k for k in keys if k in wanted]
    return [r for k in keys for r in parse_csv(spec, store[k])]


def table_files(store: MutableMapping, spec: TableSpec) -> list[str]:
    """The relative paths of a table's files present in ``store``, sorted."""
    if spec.time_column is None:
        return [f"{spec.name}.csv"] if f"{spec.name}.csv" in store else []
    prefix = f"{spec.name}/"
    return sorted(k for k in store if k.startswith(prefix) and k.endswith(".csv"))


def write_rows(store: MutableMapping, spec: TableSpec, rows: Iterable[dict]) -> int:
    """Merge ``rows`` into the table's files; return how many files changed."""
    by_path: dict[str, list[dict]] = {}
    for r in rows:
        by_path.setdefault(spec.path_for(r), []).append(r)
    changed = 0
    for path, new in by_path.items():
        old_text = store.get(path)
        old = parse_csv(spec, old_text) if old_text else []
        text = dump_csv(spec, merge_rows(spec, old, new))
        if text != old_text:
            store[path] = text
            changed += 1
    return changed
