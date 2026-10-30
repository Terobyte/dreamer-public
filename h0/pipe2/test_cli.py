import contextlib
import io
import json
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class CliTest(unittest.TestCase):
    def test_missing_caps_refused_before_transport_creation(self):
        from pipe2.__main__ import main
        for missing in ('usd', 'calls', 'tokens'):
            args = ['run', tempfile.mkdtemp(), '--run-dir', tempfile.mkdtemp()]
            for kind in ('usd', 'calls', 'tokens'):
                if kind != missing:
                    args += ['--cap-' + kind, '1000000']
            with patch('pipe2.__main__.HttpTransport') as transport, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(args), 2)
                transport.assert_not_called()

    def test_run_fake_real_engine(self):
        from pipe2.__main__ import main
        root = Path(tempfile.mkdtemp()); task = root / 'task'; task.mkdir()
        (task / 'TASK.md').write_text('two rooms')
        with contextlib.redirect_stdout(io.StringIO()):
            result = main(['run', str(task), '--run-dir', str(root / 'run'), '--fake'])
        self.assertEqual(result, 0)
        report = json.loads((root / 'run/report.json').read_text())
        self.assertEqual([r['status'] for r in report['rooms'].values()], ['green', 'green'])
        self.assertTrue((root / 'run/dist/index.html').exists())
        self.assertFalse(report['stopped_by_cap'])

    def test_measure_replays_messages_and_records_n_calls(self):
        from pipe2.measure import measure
        from pipe2.ledger import Ledger, load_prices
        from pipe2.spark import Spark
        root = Path(tempfile.mkdtemp()); (root / 'rooms/A').mkdir(parents=True)
        (root / 'plan.json').write_text(json.dumps({'rooms': {'A': {}}}))
        messages = [{'role': 'user', 'content': 'build A'}]
        (root / 'rooms/A/builder_0.messages.json').write_text(json.dumps(messages))
        bodies = []
        class Transport:
            def post(self, body, timeout):
                bodies.append(body)
                return {'choices': [{'message': {'content': '{}'}, 'finish_reason': 'stop'}],
                        'usage': {'prompt_tokens': 20, 'completion_tokens': 10}}
        ledger = Ledger(root / 'events.jsonl', load_prices(), 10, 5, 1000000)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            measure(Spark(Transport(), ledger), root, role='builder', effort='high', n=3)
        self.assertEqual(len(bodies), 3)
        self.assertEqual(bodies[0]['messages'], messages)
        self.assertIn('p50', out.getvalue()); self.assertIn('p90', out.getvalue())
        self.assertEqual(len(ledger.path.read_text().splitlines()), 3)

    def test_tick_loop_injected_clock(self):
        from pipe2.__main__ import tick_loop
        import threading
        stop = threading.Event(); now = [0]; times = []
        class Warmth:
            def tick(self): times.append(now[0])
        def sleep(sec):
            now[0] += sec
            if len(times) >= 40: stop.set()
        tick_loop(Warmth(), stop, sleep, interval=30)
        self.assertEqual(len(times), 40)
        self.assertLessEqual(max(b - a for a, b in zip(times, times[1:])), 60)

    def test_signal_resets_gpu_and_reports_interrupted(self):
        from pipe2 import __main__ as cli
        from pipe2.fakes import FakeEngine, FakeAutoscaler, ScenarioSpark
        scale = FakeAutoscaler(); order = []
        class SignalSpark(ScenarioSpark):
            def ask(self, role, *args):
                self.assert_started = bool(scale.calls and scale.calls[0] == (3, 0, 600))
                order.append((role, self.assert_started))
                if role == 'builder':
                    cli.on_signal(signal.SIGTERM, None)
                return super().ask(role, *args)
        root = Path(tempfile.mkdtemp()); (root / 'TASK.md').write_text('offline')
        with patch.object(cli, 'ScenarioSpark', SignalSpark), patch.object(cli, 'Engine', return_value=FakeEngine()), \
             patch.object(cli, 'FakeAutoscaler', return_value=scale), contextlib.redirect_stdout(io.StringIO()):
            code = cli.main(['run', str(root), '--run-dir', str(root / 'run'), '--fake', '--k', '3'])
        self.assertEqual(code, 130)
        self.assertTrue(all(started for role, started in order))
        self.assertEqual(scale.calls, [(3, 0, 600), (0, 0, 120)])
        self.assertEqual(json.loads((root / 'run/report.json').read_text())['status'], 'interrupted')
