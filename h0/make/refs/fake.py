"""Offline stand-ins for --fake: recorded API answers, synthetic images, scripted vision."""
import json
import zlib
from pathlib import Path

from . import commons, fandom, openverse, tavily

DATA = Path(__file__).resolve().parents[1] / 'testdata' / 'refs'


def _load(name):
    return json.loads((DATA / name).read_text())


def providers():
    f = lambda name: (lambda url, body=None: _load(name))
    return {'commons': lambda q, n: commons.search(q, n, fetch=f('commons.json')),
            'fandom': lambda q, n: fandom.search(q, n, 'fake', fetch=f('fandom.json')),
            'openverse': lambda q, n: openverse.search(q, n, fetch=f('openverse.json')),
            'tavily': lambda q, n: []}


def _fixtures():
    return sorted(p for p in DATA.iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg'))


def image(url):
    """One of the checked-in fixtures (each >= 512 px), picked stably by url."""
    imgs = _fixtures()
    return (imgs[zlib.crc32(str(url).encode()) % len(imgs)]).read_bytes()


def vision_ask(slot, images):
    return json.dumps({'keep': [0], 'cues': f'{slot}: scripted cues'})
