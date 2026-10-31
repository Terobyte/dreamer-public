"""Stage `brief`: prompt -> plan. Spark answer is checked by code against schema/brief.json."""
import json
import math
import re
from pathlib import Path

SCHEMA_PATH = Path(__file__).parent / 'schema' / 'brief.json'
_SEX = {'woman': 'female', 'man': 'male', 'female': 'female', 'male': 'male'}
_PLACE_OUTDOOR = ('lawn', 'yard', 'garden', 'oak', 'oaks', 'barbecue', 'arbor', 'street',
                  'outdoor', 'field', 'forest', 'benches')
_PLACE_INDOOR = ('library', 'room', 'bookcase', 'bookcases', 'sofa', 'blinds', 'kitchen',
                 'attic', 'bedroom', 'hall', 'cellar', 'semidarkness')


def _expect_place_type(place_text):
    """'yard' when the book scene place reads outdoor, 'room' when indoor, else None."""
    t = (place_text or '').lower()
    out = sum(1 for k in _PLACE_OUTDOOR if re.search(r'\b' + re.escape(k) + r'\b', t))
    inn = sum(1 for k in _PLACE_INDOOR if re.search(r'\b' + re.escape(k) + r'\b', t))
    if out > inn:
        return 'yard'
    if inn > out:
        return 'room'
    return None


_STOP = {'with', 'from', 'into', 'under', 'over', 'then', 'that', 'this', 'there', 'their', 'just'}


def _words(text):
    return {w for w in re.findall(r'[a-z]+', (text or '').lower()) if len(w) >= 4 and w not in _STOP}


def _query_matches(query, sid, place_text):
    """A book place's ref query must mostly use words of the book place (or its id): one
    shared word is not enough ("April attic bedroom" vs a lawn scene set in April)."""
    if not isinstance(query, str) or not query.strip():
        return False
    q = _words(query)
    if not q:
        return False
    hit = q & (_words(place_text) | _words(sid))
    return bool(hit) and 2 * len(hit) >= len(q)


class BriefFailed(Exception):
    pass


def _type_ok(v, t):
    if t == 'number':
        if isinstance(v, bool):
            return False
        if isinstance(v, int):
            return True
        return isinstance(v, float) and math.isfinite(v)
    return {'object': isinstance(v, dict), 'array': isinstance(v, list), 'string': isinstance(v, str),
            'null': v is None, 'integer': isinstance(v, int) and not isinstance(v, bool)}[t]


def _check(v, s, path, errs):
    if 'enum' in s and v not in s['enum']:
        errs.append(f'{path}: {v!r} not in enum {s["enum"]}')
        return
    if 'type' in s:
        ts = s['type'] if isinstance(s['type'], list) else [s['type']]
        if not any(_type_ok(v, t) for t in ts):
            errs.append(f'{path}: expected {"|".join(ts)}')
            return
    if 'exclusiveMinimum' in s and isinstance(v, (int, float)) and not isinstance(v, bool) \
            and not v > s['exclusiveMinimum']:
        errs.append(f'{path}: {v!r} must be > {s["exclusiveMinimum"]}')
    if isinstance(v, str):
        if len(v.strip()) < s.get('minLength', 0):
            errs.append(f'{path}: too short')
        if 'pattern' in s and re.fullmatch(s['pattern'], v) is None:
            errs.append(f'{path}: {v!r} does not match {s["pattern"]}')
    if isinstance(v, list):
        if len(v) < s.get('minItems', 0) or len(v) > s.get('maxItems', 1 << 30):
            errs.append(f'{path}: wrong item count {len(v)}')
        for i, x in enumerate(v):
            if 'items' in s:
                _check(x, s['items'], f'{path}[{i}]', errs)
    if isinstance(v, dict):
        props = s.get('properties', {})
        for k in s.get('required', []):
            if k not in v:
                errs.append(f'{path}.{k}: missing')
        for k, x in v.items():
            if k in props:
                _check(x, props[k], f'{path}.{k}', errs)
            elif s.get('additionalProperties') is False:
                errs.append(f'{path}.{k}: unexpected field')


def _book_scene(book):
    d = Path(book['dir'])
    data = json.loads((d / 'book.json').read_text(encoding='utf-8'))
    for ch in data.get('chapters', []):
        for sc in ch.get('scenes', []):
            if sc.get('id') == book['scene']:
                return data, sc
    return data, None


def _check_book(b, errs):
    if b.get('mode') == 'book' and not isinstance(b.get('book'), dict):
        errs.append('book: mode=book needs book {dir, scene}')
        return
    if not isinstance(b.get('book'), dict):
        return
    try:
        data, sc = _book_scene(b['book'])
    except (OSError, ValueError, KeyError) as e:
        errs.append(f'book: cannot read book.json ({e})')
        return
    if sc is None:
        errs.append(f'book: scene {b["book"]["scene"]!r} not in book.json')
        return
    sid = b['book']['scene']
    where = b.get('scene', {}).get('where') if isinstance(b.get('scene'), dict) else None
    if where != sid:
        errs.append(f'scene.where {where!r} does not match book scene {sid!r}')
    pids = {p.get('id') for p in b.get('places', []) if isinstance(p, dict)}
    if sid not in pids:
        errs.append(f'places: book scene {sid!r} missing (place id must match book scene)')
    place = next((p for p in b.get('places', []) if isinstance(p, dict) and p.get('id') == sid), None)
    if place is not None:
        exp = _expect_place_type(sc.get('place') if isinstance(sc, dict) else None)
        if exp and place.get('type') != exp:
            errs.append(f'places: {sid!r} type {place.get("type")!r} conflicts with book place ({exp}): {sc.get("place")!r}')
        if not _query_matches(place.get('query'), sid, sc.get('place') if isinstance(sc, dict) else None):
            errs.append(f'places: {sid!r} query {place.get("query")!r} does not describe book place {sc.get("place")!r}')
    got = {}
    for c in b.get('cast', []):
        if not isinstance(c, dict) or 'who' not in c:
            continue
        name = c['who']
        if name in got:
            errs.append(f'cast: duplicate {name!r}')
            continue
        got[name] = c
        if name not in sc.get('cast', []):
            errs.append(f'cast: {name!r} is not in book scene cast (name conflict)')
            continue
        want = _SEX.get(data['cast'].get(name, {}).get('sex'))
        if want and c.get('sex') != want:
            errs.append(f'cast {name!r}: sex {c.get("sex")!r} conflicts with book ({want})')
    for name in sc.get('cast', []):
        if name not in got:
            errs.append(f'cast: book character {name!r} missing')


def validate(b, expect_book=None):
    """Return a list of error strings; empty means valid. expect_book={dir, scene} is what the
    caller (CLI --book/--scene) asked for: the answer must be that book scene, not Spark's pick."""
    errs = []
    _check(b, json.loads(SCHEMA_PATH.read_text(encoding='utf-8')), 'brief', errs)
    if not errs:
        if expect_book is not None:
            got = b.get('book') if isinstance(b.get('book'), dict) else {}
            if b.get('mode') != 'book':
                errs.append(f'mode {b.get("mode")!r}: --book was given, mode must be book')
            if str(got.get('dir')) != str(expect_book['dir']) or got.get('scene') != expect_book['scene']:
                errs.append(f'book {got or None!r} does not match --book/--scene {expect_book!r}')
        _check_scene(b, errs)
        _check_book(b, errs)
    return errs


def _check_scene(b, errs):
    scene = b.get('scene')
    if not isinstance(scene, dict):
        return
    pids = {p.get('id') for p in b.get('places', []) if isinstance(p, dict)}
    seen_pids = set()
    for p in b.get('places', []):
        if not isinstance(p, dict):
            continue
        if p.get('id') in seen_pids:
            errs.append(f'places: duplicate id {p.get("id")!r}')
        seen_pids.add(p.get('id'))
    seen_names = set()
    where = scene.get('where')
    if where not in pids:
        errs.append(f'scene.where {where!r} does not match places {[p for p in b.get("places", []) if isinstance(p, dict)]}')
    names = {c.get('who') for c in b.get('cast', []) if isinstance(c, dict)}
    for c in b.get('cast', []):
        if not isinstance(c, dict) or 'who' not in c:
            continue
        if c['who'] in seen_names:
            errs.append(f'cast: duplicate {c["who"]!r}')
        seen_names.add(c['who'])
    who = scene.get('who')
    if isinstance(who, list):
        for n in who:
            if n not in names:
                errs.append(f'scene.who {n!r} not in cast')


def book_context(book_dir, scene_id):
    """Text block telling Spark which book scene to plan: place, cast with sex."""
    data, sc = _book_scene({'dir': str(book_dir), 'scene': scene_id})
    if sc is None:
        raise BriefFailed(f'book: scene {scene_id!r} not in {book_dir}/book.json')
    cast = [f'{n} ({data.get("cast", {}).get(n, {}).get("sex", "?")})' for n in sc.get('cast', [])]
    return (f'mode=book, book={{"dir": "{book_dir}", "scene": "{scene_id}"}}. '
            f'Place id must be "{scene_id}", query from this place: {sc.get("place")!r}. '
            f'Cast exactly, names and sex from the book: {", ".join(cast)}.')


def seed_from_book(prompt, book_dir, scene_id):
    """Offline scripted reply for --fake with a book: names, sex and place from book.json."""
    data, sc = _book_scene({'dir': str(book_dir), 'scene': scene_id})
    if sc is None:
        raise BriefFailed(f'book: scene {scene_id!r} not in {book_dir}/book.json')
    sexes = {n: _SEX.get(data.get('cast', {}).get(n, {}).get('sex'), 'female') for n in sc.get('cast', [])}
    cast = [{'who': n, 'sex': sx, 'age': 'adult', 'look': n, 'voice': 'man' if sx == 'male' else 'woman',
             'query': n} for n, sx in sexes.items()]
    ptype = _expect_place_type(sc.get('place')) or 'room'
    return {'title': (prompt or scene_id).strip()[:80] or scene_id, 'mode': 'book',
            'book': {'dir': str(book_dir), 'scene': scene_id}, 'style': 'warm gouache',
            'places': [{'id': scene_id, 'type': ptype, 'size_m': [8, 6], 'level': 0, 'next_to': [],
                        'query': sc.get('place') or scene_id, 'provider_hint': 'commons', 'fandom_wiki': None}],
            'cast': cast, 'scene': {'where': scene_id, 'who': [c['who'] for c in cast], 'want': prompt or scene_id}}


def spark_ask(spark, effort='medium'):
    """Adapter pipe2 Spark -> ask(messages): one Spark call in JSON mode, returns the JSON text."""
    def ask(messages):
        ans = spark.ask('brief', 'brief', 0, messages, effort)
        if ans.valid and ans.scene is not None:
            return json.dumps(ans.scene)
        return ans.text or f'INVALID: {ans.error}'
    return ask


def make_brief(prompt, ask, book_note=None, expect_book=None):
    """ask(messages) -> str. One retry with the error text, then BriefFailed."""
    user = prompt if not book_note else f'{prompt}\n\n{book_note}'
    messages = [{'role': 'system', 'content': 'JSON mode: answer with one JSON object only, matching '
                 'make/schema/brief.json (keys title, mode, book, style, places, cast, scene).'},
                {'role': 'user', 'content': user}]
    errs = []
    for attempt in range(2):
        reply = ask(messages)
        try:
            b = json.loads(reply)
        except ValueError as e:
            errs = [f'reply is not valid json: {e}']
        else:
            errs = validate(b, expect_book) if isinstance(b, dict) else ['reply is not a json object']
            if not errs:
                return b
        if attempt == 0:
            messages = messages + [{'role': 'assistant', 'content': reply},
                                   {'role': 'user', 'content': 'Invalid, fix and answer again:\n' + '\n'.join(errs)}]
    raise BriefFailed('; '.join(errs))


class ScenarioBrief:
    """Offline Spark stand-in: replays scripted replies in order (like pipe2 ScenarioSpark)."""
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, messages):
        self.calls.append(messages)
        if not self.replies:
            return 'INVALID: no more scripted replies'
        return self.replies.pop(0)
