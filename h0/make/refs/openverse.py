from urllib.parse import urlencode

from ._common import candidate, http_fetch, usable


def _name(lic, ver):
    lic = (lic or '').lower()
    if lic == 'cc0':
        return 'CC0'
    if lic == 'pdm':
        return 'Public domain'
    return f'CC {lic.upper()} {ver}'.strip() if lic else None


def search(query, n, fetch=None):
    data = (fetch or http_fetch)('https://api.openverse.org/v1/images/?' + urlencode({'q': query, 'page_size': n}))
    out = []
    for r in data.get('results') or []:
        lic = _name(r.get('license'), r.get('license_version'))
        c = candidate('openverse', url=r.get('url'), page_url=r.get('foreign_landing_url'),
                      title=r.get('title'), width=r.get('width'), height=r.get('height'),
                      license=lic, license_url=r.get('license_url'), author=r.get('creator'),
                      usable_for_submission=usable(lic))
        c['description'] = r.get('title') or ''
        out.append(c)
    return out[:n]
