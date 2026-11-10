"""Command line: ``ghtraffic collect | init | demo | manifest``.

``python -m ghtraffic collect --data-dir .`` is what the GitHub Action runs.
Without ``--data-dir``, data goes to ``~/.local/share/ghtraffic/data`` (never
the current directory, so a local run cannot end up committed by accident).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ghtraffic.collect import collect, write_manifest
from ghtraffic.config import DFLT_CONFIG_FILENAME, DFLT_DATA_DIR, load_settings
from ghtraffic.scaffold import DFLT_ACTION_REF, DFLT_CRON, init_data_repo
from ghtraffic.tables import Files


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ghtraffic", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="fetch traffic and merge it into the data dir")
    c.add_argument("--data-dir", default=str(DFLT_DATA_DIR))
    c.add_argument("--config", help=f"default: <data-dir>/{DFLT_CONFIG_FILENAME}")
    c.add_argument("--owner", action="append", dest="owners", help="repeatable")
    c.add_argument("--exclude", action="append", help="owner/repo glob, repeatable")
    c.add_argument("--max-workers", type=int)
    c.add_argument(
        "--fail-on-errors",
        action="store_true",
        help="exit 1 when some repo or owner failed (never for missing access)",
    )

    i = sub.add_parser("init", help="write the workflow and config into a data repo")
    i.add_argument("dir", nargs="?", default=".")
    i.add_argument("--owner", action="append", dest="owners")
    i.add_argument("--cron", default=DFLT_CRON)
    i.add_argument("--action-ref", default=DFLT_ACTION_REF)
    i.add_argument("--overwrite", action="store_true")

    d = sub.add_parser(
        "demo", help="write a synthetic data dir (for the demo dashboard)"
    )
    d.add_argument("--data-dir", required=True)
    d.add_argument("--days", type=int, default=420)

    m = sub.add_parser("manifest", help="rewrite manifest.json from the files present")
    m.add_argument("--data-dir", default=str(DFLT_DATA_DIR))
    return p


def main(argv=None) -> int:
    """Entry point of the ``ghtraffic`` command."""
    args = _parser().parse_args(argv)
    if args.cmd == "collect":
        data_dir = Path(args.data_dir)
        settings = load_settings(
            args.config or data_dir / DFLT_CONFIG_FILENAME,
            owners=args.owners,
            exclude=args.exclude,
            max_workers=args.max_workers,
        )
        report = collect(settings, store=Files(data_dir))
        failed = report.errors or report.owner_errors
        return 1 if (args.fail_on_errors and failed) else 0
    if args.cmd == "init":
        written = init_data_repo(
            args.dir,
            owners=args.owners or ("@me",),
            cron=args.cron,
            action_ref=args.action_ref,
            overwrite=args.overwrite,
        )
        print("\n".join(written) or "nothing written (files exist; --overwrite)")
        return 0
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
