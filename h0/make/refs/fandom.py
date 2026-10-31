from ._common import mediawiki


def search(query, n, wiki=None, fetch=None):
    """Fan wiki: reference only, never usable for submission."""
    if not wiki:
        return []
    return mediawiki(f'{wiki}.fandom.com', 'fandom', query, n, fetch, True)
