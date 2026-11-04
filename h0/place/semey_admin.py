"""Operator commands for the Semey world, through the running server (never by editing its files):

  cd h0 && python3 -m place.semey_admin <url> status | free N | reset | claims on|off
The admin key comes from ADMIN_KEY or meta/.env SEMEY_ADMIN_KEY; it is sent as X-Admin-Key, never printed.
"""
import json
import os
import sys
import urllib.error
import urllib.request

import keys


def call(url, body):
    k = os.environ.get("ADMIN_KEY") or keys._from_file("SEMEY_ADMIN_KEY")
    r = urllib.request.Request(url.rstrip("/") + "/api/admin", data=json.dumps(body).encode(), method="POST",
                               headers={"X-Admin-Key": k, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    url, op, rest = argv[0], argv[1], argv[2:]
    body = {"op": op}
    if op == "free":
        body["place"] = int(rest[0])
    if op == "claims":
        body["on"] = rest[0] == "on"
    code, out = call(url, body)
    print(code, json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if code == 200 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
