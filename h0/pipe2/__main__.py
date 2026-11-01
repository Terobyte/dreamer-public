"""Bounded live runs, fully offline smoke runs, and fixed-prompt measurements."""

import argparse
import json
import signal
import threading
import time
from pathlib import Path

from pipe2.assets import AssetQueue, ModalMesh, MuseImage
from pipe2.engine import Engine
from pipe2.fakes import FailedImages, FailedMeshes, FakeAutoscaler, ScenarioSpark
from pipe2.floor import Floor
from pipe2.gpu import GpuWarmth, ModalAutoscaler
from pipe2.ledger import Ledger, load_prices
from pipe2.measure import measure
from pipe2.spark import HttpTransport, Spark

REPO = Path(__file__).resolve().parents[2]
_active = None


def on_signal(signum, frame):
    if _active is not None:
        floor, warmth, ledger = _active
        floor.interrupt()
        try:
            warmth.close()
        finally:
            ledger.close()


def tick_loop(warmth, stop, sleep, interval=30):
    while not stop.is_set():
        warmth.tick()
        sleep(interval)


def _caps(parser):
    for kind in ('usd', 'calls', 'tokens'):
        parser.add_argument('--cap-' + kind, type=float if kind == 'usd' else int)


def _parser():
    parser = argparse.ArgumentParser(prog='python3 -m pipe2')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('task_dir', type=Path); run.add_argument('--run-dir', type=Path, required=True)
    _caps(run)
    run.add_argument('--k', type=int, default=2)
    run.add_argument('--effort', nargs='+', default=[])
    run.add_argument('--resume', action='store_true'); run.add_argument('--fake', action='store_true')
    bench = commands.add_parser('measure'); _caps(bench)
    bench.add_argument('--role', choices=['builder', 'critic_layout', 'critic_assets'], required=True)
    bench.add_argument('--effort', choices=['high', 'medium', 'max'], required=True)
    bench.add_argument('--n', type=int, default=15)
    bench.add_argument('--prompt-from', type=Path, required=True); bench.add_argument('--room')
    return parser


def _efforts(values):
    result = {}
    for value in values:
        role, sep, level = value.partition('=')
        if not sep or role not in ('architect', 'architect_fix', 'builder', 'fix', 'critic_layout', 'critic_assets', 'seam_fix') or level not in ('high', 'medium', 'max'):
            raise ValueError('effort must be role=high|medium|max')
        result[role] = level
    return result


def run(args):
    global _active
    effort = _efforts(args.effort)
    root = args.run_dir
    if not args.resume and any((root / name).exists() for name in ('skeleton.json', 'report.json', 'events.jsonl')):
        raise ValueError('run directory already contains a run; use --resume or a new --run-dir')
    ledger = Ledger(root / 'events.jsonl', load_prices(), args.cap_usd, args.cap_calls, args.cap_tokens,
                    resume=args.resume)
    fake = args.fake
    spark = ScenarioSpark(ledger) if fake else Spark(HttpTransport(), ledger)
    assets = AssetQueue(root / 'cache', FailedImages() if fake else MuseImage(),
                        FailedMeshes() if fake else ModalMesh(), ledger, poll_s=.01 if fake else 2)
    if fake:
        autoscaler, heartbeat = FakeAutoscaler(), {}
    else:
        import modal
        autoscaler = ModalAutoscaler()
        heartbeat = modal.Dict.from_name('dreamer-pipe2-heartbeat', create_if_missing=True)
    warmth = GpuWarmth(autoscaler, assets, ledger, heartbeat, k=args.k)
    floor = Floor(args.task_dir, root, {'spark': spark, 'engine': Engine(REPO / 'engine', shots=not fake),
                  'assets': assets, 'ledger': ledger, 'warmth': warmth, 'effort': effort}, resume=args.resume)
    stop = threading.Event()
    thread = None
    old_handlers = {}
    _active = (floor, warmth, ledger)
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            old_handlers[sig] = signal.signal(sig, on_signal)
        # warmth.start() is the floor's, after the skeleton (B25)
        thread = threading.Thread(target=tick_loop, args=(warmth, stop, stop.wait), daemon=True)
        thread.start()
        result = floor.run()
        print(json.dumps({'status': result.status, 'report': str(root / 'report.json')}))
        return 0 if result.status == 'done' else (130 if result.status == 'interrupted' else 1)
    finally:
        stop.set()
        if thread is not None:
            thread.join(timeout=2)
        assets.close()
        try:
            warmth.close()
        finally:
            ledger.close()
            _active = None
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def main(argv=None):
    parser = _parser()
    try:
        args = parser.parse_args(argv)
        fake = getattr(args, 'fake', False)
        for kind in ('usd', 'calls', 'tokens'):
            value = getattr(args, 'cap_' + kind)
            if value is None:
                if not fake:
                    parser.error('--cap-usd, --cap-calls and --cap-tokens are required for live calls')
                setattr(args, 'cap_' + kind, {'usd': 10, 'calls': 100, 'tokens': 2000000}[kind])
            elif value < 0:
                parser.error('caps must be nonnegative')
        if getattr(args, 'k', 0) < 0 or getattr(args, 'n', 1) < 1:
            parser.error('k must be nonnegative and n must be positive')
        if args.command == 'run':
            return run(args)
        ledger = Ledger(args.prompt_from / 'events.jsonl', load_prices(), args.cap_usd, args.cap_calls, args.cap_tokens,
                        resume=(args.prompt_from / 'events.jsonl').exists())
        try:
            measure(Spark(HttpTransport(), ledger), args.prompt_from, role=args.role, effort=args.effort,
                    n=args.n, room=args.room)
        finally:
            ledger.close()
        return 0
    except SystemExit as exc:
        return int(exc.code)
    except (ValueError, OSError) as exc:
        print('%s: %s' % (type(exc).__name__, exc), file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
