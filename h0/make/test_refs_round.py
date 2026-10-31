"""Round red tests: F5 slot collision, F6 uniform search(query, n)."""
import inspect
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import refs
from make.refs import fandom
from make.refs.fake import image


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)


class F5Test(NoNet):
    def test_place_and_cast_same_id_both_kept(self):
        p = {'commons': lambda q, n: [{'url': f'c-{q}-{i}', 'provider': 'commons'} for i in range(2)]}
        brief = {'places': [{'id': 'alice', 'query': 'place-q', 'provider_hint': 'commons',
                             'fandom_wiki': None}],
                 'cast': [{'who': 'alice', 'query': 'cast-q'}]}
        d = Path(tempfile.mkdtemp())
        refs.run_refs(brief, d, providers=p, loader=lambda u: image(u))
        j = json.loads((d / 'refs.json').read_text())
        urls = [c['url'] for v in j['slots'].values() for c in v]
        self.assertIn('c-place-q-0', urls)
        self.assertIn('c-cast-q-0', urls)
        files = list(d.rglob('*.png')) + list(d.rglob('*.jpg'))
        self.assertGreaterEqual(len(files), 2)


class F6Test(NoNet):
    def test_fandom_two_arg_interface_and_uniform_dispatch(self):
        sig = inspect.signature(fandom.search)
        params = list(sig.parameters.values())
        required = [p for p in params
                    if p.default is inspect.Parameter.empty
                    and p.kind in (inspect.Parameter.POSITIONAL_ONLY,
                                   inspect.Parameter.POSITIONAL_OR_KEYWORD)]
        self.assertLessEqual(len(required), 2, fandom.search)
        calls = {}

        def mk(name):
            def fn(q, n):
                calls[name] = (q, n)
                return []
            return fn
        refs.gather('q', None, {'commons': mk('commons'), 'fandom': mk('fandom'),
                                'openverse': mk('openverse'), 'tavily': mk('tavily')})
        self.assertEqual(set(calls), {'commons', 'fandom', 'openverse', 'tavily'})


class F7Test(NoNet):
    def test_case_insensitive_slot_dirs_distinct(self):
        out = Path(tempfile.mkdtemp())
        used = set()
        a = refs._unique_slot_dir(out, 'alice', used)
        used.add(a)
        b = refs._unique_slot_dir(out, 'Alice', used)
        self.assertNotEqual(str(a).lower(), str(b).lower())

    def test_alice_alice_slots_keep_own_images(self):
        p = {'commons': lambda q, n: [{'url': f'u-{q}', 'provider': 'commons'}]}
        brief = {'places': [{'id': 'alice', 'query': 'q1', 'provider_hint': 'commons',
                             'fandom_wiki': None}],
                 'cast': [{'who': 'Alice', 'query': 'q2'}]}
        d = Path(tempfile.mkdtemp())
        refs.run_refs(brief, d, providers=p, loader=lambda u: image(u))
        files = list(d.rglob('*.png')) + list(d.rglob('*.jpg'))
        self.assertGreaterEqual(len(files), 2)
        parents = {str(p.parent).lower() for p in files}
        self.assertEqual(len(parents), 2)


class F8Test(NoNet):
    def test_normal_mode_dispatches_without_live_flag(self):
        import os
        from unittest import mock
        from make import core as _core
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('DREAMER_LIVE', None)
            run = Path(tempfile.mkdtemp())
            (run / 'brief').mkdir()
            (run / 'brief' / 'brief.json').write_text(json.dumps(
                {'places': [{'id': 'x', 'query': 'attic', 'provider_hint': 'commons',
                             'fandom_wiki': None}], 'cast': []}))
            out = run / 'refs_out'
            out.mkdir()
            ctx = _core.Ctx(run, out, {'fake': False}, False, None, {'pick': 'first'})
            with mock.patch('make.refs.run_refs', return_value={}) as m:
                _core._run_refs(ctx)
            _args, kwargs = m.call_args
            providers = kwargs.get('providers')
            self.assertTrue(providers, 'non-fake refs must dispatch providers without DREAMER_LIVE')


class F9Test(NoNet):
    def test_fake_loader_uses_checked_in_fixtures(self):
        from make.refs import fake as _fake
        from make.refs.fake import DATA
        from make import refs as _refs
        imgs = sorted([p for p in DATA.iterdir()
                       if p.suffix.lower() in ('.png', '.jpg', '.jpeg')
                       and p.name != 'placeholder'])
        self.assertGreaterEqual(len(imgs), 3, 'need 3 checked-in JPEG/PNG fixtures')
        exts = {p.suffix.lower() for p in imgs}
        self.assertIn('.png', exts)
        self.assertTrue('.jpg' in exts or '.jpeg' in exts)
        for p in imgs[:3]:
            s = _refs.sniff(p.read_bytes())
            self.assertIsNotNone(s, p.name)
            self.assertGreaterEqual(min(s[1], s[2]), 512, p.name)
        blobs = {_fake.image(u) for u in ('u-a', 'u-b', 'u-c', 'u-d', 'u-e')}
        self.assertGreater(len(blobs), 1, 'fake loader must vary by url')
        raw = {p.read_bytes() for p in imgs}
        for b in blobs:
            self.assertIn(b, raw, 'fake loader must return fixture bytes')


if __name__ == '__main__':
    unittest.main()
