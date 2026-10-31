"""python3 -m make "<промпт>" [--book DIR --scene ID] [--run DIR] [--only X | --from X] [--fresh] ..."""
import argparse
import sys
import time
from pathlib import Path

from . import core

RUNS = Path(__file__).resolve().parents[2] / "runs"


def main(argv=None):
    ap = argparse.ArgumentParser(prog="make")
    ap.add_argument("prompt", nargs="?")
    ap.add_argument("--run")
    ap.add_argument("--only")
    ap.add_argument("--from", dest="from_")
    ap.add_argument("--until")
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--max-dollars", type=float)
    ap.add_argument("--split")
    ap.add_argument("--effort")
    ap.add_argument("--pick", default="first", choices=["first", "vision"])
    ap.add_argument("--book", help="book dir with book.json, e.g. dream/books/gwtw")
    ap.add_argument("--scene", help="scene id in book.json")
    a = ap.parse_args(argv)
    run = Path(a.run) if a.run else RUNS / time.strftime("%Y%m%d-%H%M%S")
    try:
        res = core.run_make(run, a.prompt, only=a.only, from_=a.from_, until=a.until,
                            fresh=a.fresh, fake=a.fake, check=a.check,
                            max_dollars=a.max_dollars, split=a.split,
                            effort=a.effort, pick=a.pick,
                            book=a.book, scene=a.scene)
    except (core.MissingInput, core.LockError) as e:
        print(e, file=sys.stderr)
        return 1
    for sid, st in res.items():
        print(f"{sid}: {st}")
    return 1 if any(v in ("failed", "blocked") for v in res.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
