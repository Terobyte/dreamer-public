"""run_refs: a place with no kept picture prints `WARN no refs for <place>` and lands in refs.json warnings."""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from make import refs
from make.test_refs import png

BRIEF = {'places': [{'id': 'bedroom', 'query': 'Mirai bedroom', 'provider_hint': 'any'}], 'cast': []}


def cand(i):
    return {'url': f'http://x/{i}.png', 'title': 't', 'width': 800, 'height': 800, 'provider': 'commons',
            'description': 'd', 'license': 'cc0', 'page': 'http://x', 'source': 'x'}


class RefsWarn(unittest.TestCase):
    def _run(self, providers, loader, local=None, brief=BRIEF):
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            buf = io.StringIO()
            with redirect_stdout(buf):
                refs.run_refs(brief, out, providers=providers, loader=loader, local=local)
            return buf.getvalue(), json.loads((out / 'refs.json').read_text())

    def _prov(self, items):
        return {'commons': lambda q, n: list(items), 'openverse': lambda q, n: [], 'tavily': lambda q, n: []}

    def test_empty_provider(self):
        text, data = self._run(self._prov([]), lambda u: png(600, 600))
        self.assertIn('WARN no refs for bedroom', text)
        self.assertEqual(data['warnings'], ['bedroom'])

    def test_all_downloads_rejected(self):
        def bad(u):
            raise IOError('nope')
        text, data = self._run(self._prov([cand(1), cand(2)]), bad)
        self.assertIn('WARN no refs for bedroom', text)
        self.assertEqual(data['warnings'], ['bedroom'])

    def test_local_slot_empty(self):
        text, data = self._run(self._prov([]), lambda u: b'', local={'bedroom': ([], 'cues')})
        self.assertIn('WARN no refs for bedroom', text)
        self.assertEqual(data['warnings'], ['bedroom'])

    def test_control_accepted_picture(self):
        text, data = self._run(self._prov([cand(1)]), lambda u: png(600, 600))
        self.assertNotIn('WARN', text)
        self.assertEqual(data['warnings'], [])

    def test_shared_id_character_empty_no_warning(self):
        brief = {'places': [{'id': 'same', 'query': 'place q', 'provider_hint': 'any'}],
                 'cast': [{'who': 'same', 'query': 'char q'}]}

        def commons(q, n):
            return [cand(1)] if q == 'place q' else []
        prov = {'commons': commons, 'openverse': lambda q, n: [], 'tavily': lambda q, n: []}
        text, data = self._run(prov, lambda u: png(600, 600), brief=brief)
        self.assertNotIn('WARN', text)
        self.assertEqual(data['warnings'], [])


if __name__ == '__main__':
    unittest.main()
