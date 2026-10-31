"""Phase M2: refs providers, licenses, download filter, pick, refs.json/cues.md."""
import json
import os
import struct
import tempfile
import unittest
import urllib.request
import zlib
from pathlib import Path
from unittest import mock

from make import refs
from make.refs import commons, fandom, openverse, tavily

DATA = Path(__file__).parent / 'testdata' / 'refs'


def load(name):
    return json.loads((DATA / name).read_text())


def png(w, h):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x80' * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def jpeg(w, h):
    return (b'\xff\xd8\xff\xc0' + struct.pack('>HBHHB', 11, 8, h, w, 1) + b'\x01\x11\x00' + b'\xff\xd9')


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)


class ProviderTest(NoNet):
    def test_commons_licenses(self):
        out = commons.search('attic', 5, fetch=lambda url, body=None: load('commons.json'))
        by = {c['url']: c for c in out}
        self.assertTrue(by['https://upload.example/a.jpg']['usable_for_submission'])
        self.assertFalse(by['https://upload.example/b.jpg']['usable_for_submission'])
        a = by['https://upload.example/a.jpg']
        for k in ('url', 'page_url', 'provider', 'title', 'width', 'height', 'license',
                  'license_url', 'author', 'usable_for_submission'):
            self.assertIn(k, a)
        self.assertEqual((a['provider'], a['license'], a['width'], a['author']), ('commons', 'CC BY-SA 4.0', 1024, 'Ann'))

    def test_fandom_never_usable_and_host(self):
        seen = []
        def fetch(url, body=None):
            seen.append(url)
            return load('fandom.json')
        out = fandom.search('attic', 5, wiki='spongebob', fetch=fetch)
        self.assertTrue(out and not any(c['usable_for_submission'] for c in out))
        self.assertTrue(all(c['provider'] == 'fandom' for c in out))
        self.assertIn('spongebob.fandom.com', seen[0])

    def test_openverse(self):
        out = openverse.search('attic', 5, fetch=lambda url, body=None: load('openverse.json'))
        self.assertEqual([c['usable_for_submission'] for c in out], [True, False])

    def test_tavily_without_key_not_called(self):
        calls = []
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('TAVILY_API_KEY', None)
            self.assertEqual(tavily.search('attic', 5, fetch=lambda *a, **k: calls.append(1)), [])
        self.assertEqual(calls, [])

    def test_tavily_with_key_false(self):
        with mock.patch.dict(os.environ, {'TAVILY_API_KEY': 'k'}):
            out = tavily.search('attic', 5, fetch=lambda url, body=None: load('tavily.json'))
        self.assertEqual(len(out), 2)
        self.assertFalse(any(c['usable_for_submission'] for c in out))


class PipelineTest(NoNet):
    def blobs(self):
        return {'https://upload.example/a.jpg': jpeg(1024, 768),
                'https://upload.example/b.jpg': b'RIFF....WEBPxxxx',
                'https://ov.example/c.png': png(600, 600),
                'https://ov.example/d.jpg': jpeg(700, 300),
                'https://web.example/e.jpg': b'GIF89a....',
                'https://web.example/f.jpg': jpeg(512, 512)}

    def providers(self):
        return {'commons': lambda q, n: commons.search(q, n, fetch=lambda u, b=None: load('commons.json')),
                'openverse': lambda q, n: openverse.search(q, n, fetch=lambda u, b=None: load('openverse.json')),
                'tavily': lambda q, n: [dict(c, provider='tavily', usable_for_submission=False)
                                        for c in tavily.search('x', n, key='k', fetch=lambda u, b=None: load('tavily.json'))]}

    def test_filter_signature_and_size(self):
        blobs = self.blobs()
        cands = [dict(url=u) for u in blobs]
        ok = refs.download_filter(cands, lambda u: blobs[u])
        self.assertEqual([c['url'] for c in ok],
                         ['https://upload.example/a.jpg', 'https://ov.example/c.png', 'https://web.example/f.jpg'])

    def test_download_parallel(self):
        import threading
        seen, lock, barrier = set(), threading.Lock(), threading.Barrier(2, timeout=5)
        def loader(u):
            barrier.wait()
            with lock:
                seen.add(threading.get_ident())
            return jpeg(600, 600)
        refs.download_filter([dict(url='u1'), dict(url='u2')], loader)
        self.assertEqual(len(seen), 2)

    def run_refs(self, pick='first', ask=None):
        brief = {'places': [{'id': 'attic', 'type': 'room', 'query': 'attic', 'provider_hint': 'commons', 'fandom_wiki': None},
                            {'id': 'mine', 'type': 'room', 'query': None, 'provider_hint': 'any', 'fandom_wiki': None}],
                 'cast': []}
        blobs = self.blobs()
        out = Path(tempfile.mkdtemp())
        refs.run_refs(brief, out, providers=self.providers(), loader=lambda u: blobs[u], pick=pick, ask=ask)
        return out

    def test_first_deterministic_and_files(self):
        a = self.run_refs()
        b = self.run_refs()
        ja, jb = json.loads((a / 'refs.json').read_text()), json.loads((b / 'refs.json').read_text())
        self.assertEqual(ja, jb)
        slot = ja['slots']['attic']
        self.assertEqual(len(slot), 6)  # all candidates, even rejected ones
        kept = [c['url'] for c in slot if c['kept']]
        self.assertEqual(kept, ['https://upload.example/a.jpg', 'https://ov.example/c.png', 'https://web.example/f.jpg'])
        self.assertEqual(ja['slots']['mine'], [])
        self.assertTrue(any((a / 'attic').glob('*.jpg')) and any((a / 'attic').glob('*.png')))
        self.assertIn('An old attic room', (a / 'cues.md').read_text())

    def test_vision_on_scenario_fake(self):
        asked = []
        def ask(slot, images):
            asked.append((slot, len(images)))
            return json.dumps({'keep': [1], 'cues': 'oak beams'})
        out = self.run_refs('vision', ask)
        ja = json.loads((out / 'refs.json').read_text())
        kept = [c['url'] for c in ja['slots']['attic'] if c['kept']]
        self.assertEqual(kept, ['https://ov.example/c.png'])
        self.assertEqual(asked, [('attic', 3)])
        self.assertIn('oak beams', (out / 'cues.md').read_text())


class FindingsTest(NoNet):
    """Blocking findings round: hint priority, personal cues, slot path, provider fallback."""

    def test_hint_beats_provider_rank(self):
        from make.refs.fake import image
        p = {'commons': lambda q, n: [{'url': f'c{i}', 'provider': 'commons'} for i in range(3)],
             'fandom': lambda q, n, wiki=None: [{'url': 'f', 'provider': 'fandom'}],
             'openverse': lambda q, n: [], 'tavily': lambda q, n: []}
        d = Path(tempfile.mkdtemp())
        refs.run_refs({'places': [{'id': 'x', 'query': 'q', 'provider_hint': 'fandom',
                                   'fandom_wiki': 'w'}], 'cast': []},
                      d, providers=p, loader=lambda u: image(u))
        kept = [c['url'] for c in json.loads((d / 'refs.json').read_text())['slots']['x'] if c['kept']]
        self.assertIn('f', kept)

    def test_personal_place_cues(self):
        d = Path(tempfile.mkdtemp())
        refs.run_refs({'places': [{'id': 'mine', 'query': None, 'provider_hint': 'any',
                                   'fandom_wiki': None, 'look': 'round olive room'}],
                       'cast': [], 'scene': {'where': 'mine', 'who': [], 'want': 'my attic nook'}},
                      d, providers={}, loader=lambda u: b'')
        j = json.loads((d / 'refs.json').read_text())
        self.assertEqual(j['slots']['mine'], [])
        cues = (d / 'cues.md').read_text()
        self.assertIn('## mine', cues)
        self.assertTrue('round olive room' in cues or 'my attic nook' in cues)

    def test_slot_path_stays_inside_out(self):
        from make.refs.fake import image
        p = {'commons': lambda q, n: [{'url': 'c0', 'provider': 'commons'}]}
        d = Path(tempfile.mkdtemp())
        before = set(d.parent.iterdir())
        refs.run_refs({'places': [], 'cast': [{'who': '../../escaped', 'query': 'q'}]},
                      d, providers=p, loader=lambda u: image(u))
        self.assertEqual(before, set(d.parent.iterdir()))
        self.assertTrue(list(d.rglob('*.png')) + list(d.rglob('*.jpg')))

    def test_provider_failure_falls_through(self):
        from make.refs.fake import image
        def boom(q, n):
            raise TimeoutError('down')
        p = {'commons': boom,
             'openverse': lambda q, n: [{'url': 'o0', 'provider': 'openverse'}]}
        d = Path(tempfile.mkdtemp())
        refs.run_refs({'places': [{'id': 'x', 'query': 'q', 'provider_hint': 'commons',
                                   'fandom_wiki': None}], 'cast': []},
                      d, providers=p, loader=lambda u: image(u))
        kept = [c['url'] for c in json.loads((d / 'refs.json').read_text())['slots']['x'] if c['kept']]
        self.assertEqual(kept, ['o0'])


if __name__ == '__main__':
    unittest.main()
