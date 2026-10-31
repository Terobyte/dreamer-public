from ._common import mediawiki


def search(query, n, fetch=None):
    return mediawiki('commons.wikimedia.org', 'commons', query, n, fetch, False)
