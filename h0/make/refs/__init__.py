"""Stage `refs`: find reference images per slot, download, filter, pick."""
import concurrent.futures as cf
import json
import re
import struct
from pathlib import Path

from . import commons, fandom, openverse, tavily
from ._common import FIELDS

ORDER = ('commons', 'fandom', 'openverse', 'tavily')
PER_SLOT = 12
MIN_SIDE = 512
KEEP_FIRST = 3
KEEP_VISION = 6


def sniff(data):
    """(ext, width, height) for PNG/JPEG by signature, else None (WebP/SVG/GIF are rejected)."""
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        w, h = struct.unpack('>II', data[16:24])
        return 'png', w, h
    if data[:2] == b'\xff\xd8':
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xff:
                i += 1
                continue
            m = data[i + 1]
            if m in (0xd8, 0x01) or 0xd0 <= m <= 0xd7:
                i += 2
                continue
            seg = struct.unpack('>H', data[i + 2:i + 4])[0]
            if 0xc0 <= m <= 0xcf and m not in (0xc4, 0xc8, 0xcc):
                h, w = struct.unpack('>HH', data[i + 5:i + 9])
                return 'jpg', w, h
            i += 2 + seg
    return None


def download_filter(cands, loader, workers=8):
    """Download in parallel; keep PNG/JPEG with short side >= 512 (input order). Adds _bytes/_ext."""
    def one(c):
        try:
            data = loader(c['url'])
        except Exception:
            return None
        s = sniff(data) if isinstance(data, (bytes, bytearray)) else None
        if not s or min(s[1], s[2]) < MIN_SIDE:
            return None
        return dict(c, _bytes=bytes(data), _ext=s[0], width=s[1], height=s[2])
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        return [r for r in ex.map(one, cands) if r]


def gather(query, hint, providers, wiki=None):
    import functools
    import inspect
    bound = dict(providers)
    if 'fandom' in bound:
        try:
            has_wiki = 'wiki' in inspect.signature(bound['fandom']).parameters
        except (ValueError, TypeError):
            has_wiki = False
        if has_wiki:
            if not wiki:
                del bound['fandom']
            else:
                bound['fandom'] = functools.partial(bound['fandom'], wiki=wiki)
    order = ([hint] if hint in ORDER else []) + [p for p in ORDER if p != hint]
    out, seen = [], set()
    for name in order:
        if len(out) >= PER_SLOT or name not in bound:
            continue
        try:
            found = bound[name](query, PER_SLOT - len(out))
        except Exception:
            continue
        for c in found:
            if c.get('url') and c['url'] not in seen and len(out) < PER_SLOT:
                seen.add(c['url'])
                out.append(c)
    return out


def _slots(brief):
    for p in brief.get('places') or []:
        yield p['id'], p, p.get('query'), p.get('provider_hint'), p.get('fandom_wiki')
    for c in brief.get('cast') or []:
        yield c['who'], c, c.get('query'), 'commons', None


def _safe_slot(out, sid):
    """Slot dir stays inside out: sanitize the id, then verify the resolved path."""
    safe = re.sub(r'[^A-Za-z0-9]+', '_', str(sid)).strip('_') or 'slot'
    d = (out / safe).resolve()
    if out.resolve() not in (d, *d.parents):
        raise ValueError(f'bad slot id: {sid!r}')
    return d


def _unique_slot_dir(out, sid, used):
    """Unique dir per slot: same sanitizing as _safe_slot, suffix __2.. on collision.

    Comparison is case-insensitive: on a case-insensitive filesystem `alice` and
    `Alice` resolve to the same directory, so they must get distinct names."""
    base = re.sub(r'[^A-Za-z0-9]+', '_', str(sid)).strip('_') or 'slot'
    seen = {str(u).lower() for u in used}
    safe, i = base, 2
    while True:
        d = _safe_slot(out, safe)
        if str(d).lower() not in seen:
            return d
        safe, i = f'{base}__{i}', i + 1


def _personal_cues(sid, info, brief):
    """Features of a query:null personal place: look/description + user words (scene.want)."""
    bits = []
    for k in ('look', 'description'):
        v = (info or {}).get(k)
        if isinstance(v, str) and v.strip():
            bits.append(v.strip())
    sc = brief.get('scene') or {}
    if sc.get('where') == sid and isinstance(sc.get('want'), str) and sc['want'].strip():
        bits.append(sc['want'].strip())
    return '\n'.join(f'- {b}' for b in bits)


def book_local(brief, base):
    """{place id: ([picture paths], cues)} from the book scene's own `refs`/`ref_cues` (storyboard).

    A private book is not on the web; its storyboard is the reference. Paths are relative to the
    book dir, which is relative to `base` (h0) unless absolute."""
    b = brief.get('book') or {}
    if not b.get('dir') or not b.get('scene'):
        return {}
    bdir = Path(b['dir']) if Path(b['dir']).is_absolute() else Path(base) / b['dir']
    try:
        book = json.loads((bdir / 'book.json').read_text())
    except (OSError, ValueError):
        return {}
    for ch in book.get('chapters') or []:
        for sc in ch.get('scenes') or []:
            if sc.get('id') == b['scene'] and sc.get('refs'):
                pics = [bdir / r for r in sc['refs'] if (bdir / r).is_file()]
                places = [p['id'] for p in brief.get('places') or []]
                return {pid: (pics, sc.get('ref_cues') or '') for pid in places[:1]} if pics else {}
    return {}


def _local_slot(paths, text):
    kept = []
    for p in paths:
        data = Path(p).read_bytes()
        s = sniff(data)
        if s:
            kept.append({'url': Path(p).resolve().as_uri(), 'provider': 'book', 'title': Path(p).stem,
                         'description': text, '_bytes': data, '_ext': s[0], 'width': s[1], 'height': s[2]})
    return kept


def run_refs(brief, out, *, providers, loader, pick='first', ask=None, local=None):
    """Writes out/refs.json (all candidates + kept), out/cues.md, out/<slot>/<n>.<ext>.

    `local` = {slot id: ([paths], cues)} — the user's own pictures; used instead of a web search."""
    out = Path(out)
    local = local or {}
    slots, cues, used_dirs = {}, [], set()
    for sid, info, query, hint, wiki in _slots(brief):
        key = sid
        if key in slots:
            i = 2
            while f'{sid}__{i}' in slots:
                i += 1
            key = f'{sid}__{i}'
        if sid in local:
            kept = _local_slot(*local[sid])
            d = _unique_slot_dir(out, key, used_dirs)
            used_dirs.add(d)
            for n, c in enumerate(kept):
                d.mkdir(parents=True, exist_ok=True)
                (d / f'{n}.{c["_ext"]}').write_bytes(c['_bytes'])
            slots[key] = [dict({k: c.get(k) for k in FIELDS}, description=c['description'], kept=True)
                          for c in kept]
            cues.append(f'## {key}\n\n{local[sid][1]}\n')
            continue
        if not query:
            slots[key] = []
            cues.append(f'## {key}\n\n{_personal_cues(sid, info, brief)}\n')
            continue
        cands = gather(query, hint, providers, wiki)
        good = download_filter(cands, loader)
        block = {}
        for c in cands:
            block.setdefault(c.get('provider'), len(block))
        good.sort(key=lambda c: (block.get(c['provider'], 9), -(c['width'] or 0) * (c['height'] or 0)))
        text = None
        if pick == 'vision' and good:
            shown = good[:KEEP_VISION]
            ans = json.loads(ask(sid, shown))
            idx = [i for i in ans.get('keep', []) if isinstance(i, int) and 0 <= i < len(shown)]
            kept, text = [shown[i] for i in idx], ans.get('cues') or ''
        else:
            kept = good[:KEEP_FIRST]
        kept_urls = {c['url'] for c in kept}
        d = _unique_slot_dir(out, key, used_dirs)
        used_dirs.add(d)
        for n, c in enumerate(kept):
            d.mkdir(parents=True, exist_ok=True)
            (d / f'{n}.{c["_ext"]}').write_bytes(c['_bytes'])
        slots[key] = [dict({k: c.get(k) for k in FIELDS}, description=c.get('description', ''),
                           kept=c['url'] in kept_urls) for c in cands]
        if text is None:
            text = '\n'.join(f'- {c.get("title") or ""}: {c.get("description") or ""}' for c in kept)
        cues.append(f'## {key}\n\n{text}\n')
    (out / 'refs.json').write_text(json.dumps({'pick': pick, 'slots': slots}, ensure_ascii=False, indent=2))
    (out / 'cues.md').write_text('\n'.join(cues))
    return slots
