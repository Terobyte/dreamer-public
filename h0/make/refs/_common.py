"""Shared bits for ref providers: license rule, html strip, stdlib http, MediaWiki parser."""
import html
import json
import re
import urllib.request

_USABLE = re.compile(r'(?i)(public domain|pd-.*|cc0.*|cc by(-sa)? .*)')
FIELDS = ('url', 'page_url', 'provider', 'title', 'width', 'height', 'license', 'license_url',
          'author', 'usable_for_submission')


def usable(license_name):
    return bool(license_name) and _USABLE.fullmatch(license_name.strip()) is not None


def strip_html(text):
    return html.unescape(re.sub(r'<[^>]+>', '', text or '')).strip()


def http_fetch(url, body=None, headers=None):
    """GET (or POST json when body) -> parsed json. Providers take `fetch` so tests stay offline."""
    h = {'User-Agent': 'dreamer-make/0.6 (refs)'}
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=30) as r:
        return json.loads(r.read().decode())


def candidate(provider, **kw):
    c = {k: None for k in FIELDS}
    c.update(provider=provider, usable_for_submission=False)
    c.update(kw)
    return c


def mediawiki(host, provider, query, n, fetch, always_false):
    from urllib.parse import urlencode
    q = urlencode({'action': 'query', 'generator': 'search', 'gsrnamespace': 6, 'gsrsearch': query,
                   'gsrlimit': n, 'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata', 'format': 'json'})
    data = (fetch or http_fetch)(f'https://{host}/w/api.php?{q}' if provider == 'commons'
                                 else f'https://{host}/api.php?{q}')
    pages = (data.get('query') or {}).get('pages') or {}
    out = []
    for _, p in sorted(pages.items(), key=lambda kv: (kv[1].get('index', 0), kv[0])):
        for ii in p.get('imageinfo') or []:
            md = ii.get('extmetadata') or {}
            val = lambda k: strip_html((md.get(k) or {}).get('value'))
            lic = val('LicenseShortName') or None
            c = candidate(provider, url=ii.get('url'), page_url=ii.get('descriptionurl'),
                          title=p.get('title'), width=ii.get('width'), height=ii.get('height'),
                          license=lic, license_url=val('LicenseUrl') or None,
                          author=val('Artist') or None,
                          usable_for_submission=False if always_false else usable(lic))
            c['description'] = val('ImageDescription')
            out.append(c)
    return out[:n]
