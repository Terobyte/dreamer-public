#!/bin/sh
# tero gate for meta: h0/dream, h0/make, engine vitest. Files in tools/gate_skip.txt are left out.
cd "$(dirname "$0")/.." || exit 2
skip=$(grep -v '^#' tools/gate_skip.txt | grep -v '^$')
rc=0

dream=$(cd h0/dream && for f in test_*.py; do echo "$skip" | grep -qx "h0/dream/$f" || echo "${f%.py}"; done)
(cd h0/dream && python3 -m unittest -q $dream) || rc=1

if [ -d h0/make ]; then
  (cd h0 && python3 -m unittest discover -s make -t . -q); c=$?
  [ $c -ne 0 ] && [ $c -ne 5 ] && rc=1
fi

ex=""
for f in $(echo "$skip" | grep '^engine/'); do ex="$ex --exclude ${f#engine/}"; done
(cd engine && npx vitest run $ex) || rc=1

exit $rc
