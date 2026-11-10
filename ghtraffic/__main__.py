"""Command line: ``ghtraffic collect | init | guard | demo | manifest``.

``python -m ghtraffic collect --data-dir .`` is what the GitHub Action runs.
Without ``--data-dir``, data goes to ``~/.local/share/ghtraffic/data`` (never
the current directory, so a local run cannot end up committed by accident).
Every :class:`~ghtraffic.config.Settings` field is also a ``collect`` flag.
"""

from __future__ import annotations

import argparse
import sys
import typing
from dataclasses import fields
from pathlib import Path

from ghtraffic.collect import collect, has_private_data, write_manifest
from ghtraffic.config import (
    DFLT_CONFIG_FILENAME,
    DFLT_DATA_DIR,
    Settings,
    load_settings,
)
from ghtraffic.scaffold import DFLT_CRON, default_action_ref, init_data_repo
from ghtraffic.tables import Files


def _add_settings_flags(parser: argparse.ArgumentParser) -> None:
    """One flag per Settings field, so a new setting needs no CLI edit."""
    hints = typing.get_type_hints(Settings)
    for f in fields(Settings):
        flag = "--" + f.name.replace("_", "-")
        kind = hints[f.name]
        if kind is bool:
            parser.add_argument(flag, action=argparse.BooleanOptionalAction)
        elif typing.get_origin(kind) is tuple:
            parser.add_argument(flag, action="append", help="repeatable")
        else:
            parser.add_argument(flag, type=kind)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ghtraffic", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="fetch traffic and merge it into the data dir")
    c.add_argument("--data-dir", default=str(DFLT_DATA_DIR))
    c.add_argument("--config", help=f"default: <data-dir>/{DFLT_CONFIG_FILENAME}")
    c.add_argument(
        "--fail-on-errors",
        action="store_true",
        help="exit 1 when some repo or owner failed (never for missing access)",
    )
    _add_settings_flags(c)

    i = sub.add_parser("init", help="write the workflow and config into a data repo")
    i.add_argument("dir", nargs="?", default=".")
    i.add_argument("--owner", action="append", dest="owners")
    i.add_argument("--cron", default=DFLT_CRON)
    i.add_argument("--action-ref", help="default: this ghtraffic's release tag")
    i.add_argument("--overwrite", action="store_true")

    g = sub.add_parser(
        "guard", help="exit 1 if private data would be committed to a public repo"
    )
    g.add_argument("--data-dir", default=".")
    g.add_argument("--repo", required=True, help="owner/name of the data repo")

    d = sub.add_parser(
        "demo", help="write a synthetic data dir (for the demo dashboard)"
    )
    d.add_argument("--data-dir", required=True)
    d.add_argument("--days", type=int, default=420)

    m = sub.add_parser("manifest", help="rewrite manifest.json from the files present")
    m.add_argument("--data-dir", default=str(DFLT_DATA_DIR))
    return p


def _guard(data_dir: str, repo: str) -> int:
    from ghtraffic.github import make_rest

    if not make_rest()(f"/repos/{repo}").get("private", False) and has_private_data(
        Files(data_dir)
    ):
        print(
            f"ghtraffic: REFUSING to commit: {repo} is public and the history "
            "holds private repos. Make the data repo private, or exclude private "
            "repos, or set the action input allow-public: true.",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv=None) -> int:
    """Entry point of the ``ghtraffic`` command."""
    args = _parser().parse_args(argv)
    if args.cmd == "collect":
        data_dir = Path(args.data_dir)
        overrides = {f.name: getattr(args, f.name) for f in fields(Settings)}
        settings = load_settings(
            args.config or data_dir / DFLT_CONFIG_FILENAME, **overrides
        )
        report = collect(settings, store=Files(data_dir), log=print)
        failed = report.errors or report.owner_errors
        return 1 if (args.fail_on_errors and failed) else 0
    if args.cmd == "init":
        written = init_data_repo(
            args.dir,
            owners=args.owners or ("@me",),
            cron=args.cron,
            action_ref=args.action_ref or default_action_ref(),
            overwrite=args.overwrite,
        )
        print("\n".join(written) or "nothing written (files exist; --overwrite)")
        return 0
    if args.cmd == "guard":
        return _guard(args.data_dir, args.repo)
    if args.cmd == "demo":
        from ghtraffic.demo import make_demo_data

        make_demo_data(Files(args.data_dir), n_days=args.days)
        return 0
    if args.cmd == "manifest":
        from datetime import date

        write_manifest(Files(args.data_dir), updated=date.today().isoformat())
        return 0
    return 2  # pragma: no cover


if __name__ == "__main__":
    sys.exit(main())
