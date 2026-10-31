import os

from ._common import candidate, http_fetch


def search(query, n, fetch=None, key=None):
    """Last resort; off without TAVILY_API_KEY (fetch is never called then). Never usable."""
    key = key or os.environ.get('TAVILY_API_KEY')
    if not key:
        return []
    data = (fetch or http_fetch)('https://api.tavily.com/search',
                                 {'api_key': key, 'query': query, 'include_images': True,
                                  'include_image_descriptions': True, 'max_results': n})
    out = []
    for im in data.get('images') or []:
        im = {'url': im} if isinstance(im, str) else im
        c = candidate('tavily', url=im.get('url'), title=im.get('description'))
        c['description'] = im.get('description') or ''
        out.append(c)
    return out[:n]
