#!/bin/sh
# tero gate for meta: h0/dream, h0/make, h0/pipe2 + servers, engine vitest. Files in tools/gate_skip.txt are left out.
# The three suites run side by side; dream and make run their test classes in parallel (tools/ptest.py).
cd "$(dirname "$0")/.." || exit 2
skip=$(grep -v '^#' tools/gate_skip.txt | grep -v '^$')
logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

dream=$(cd h0/dream && for f in test_*.py; do echo "$skip" | grep -qx "h0/dream/$f" || echo "${f%.py}"; done)
(python3 tools/ptest.py --cwd h0/dream $dream; echo $? >"$logs/dream.rc") >"$logs/dream" 2>&1 &

if [ -d h0/make ]; then
  make=$(cd h0/make && for f in test_*.py; do echo "$skip" | grep -qx "h0/make/$f" || echo "make.${f%.py}"; done)
  (python3 tools/ptest.py --cwd h0 $make; echo $? >"$logs/make.rc") >"$logs/make" 2>&1 &
fi

# pipe2 and the servers are pytest suites. A server test stubs modules (gate_test) and
# live/ and squid_live/ both have test_bugs_server.py, so each server file gets its own process
(rc=0
 ig=""
 for f in $(echo "$skip" | grep '^h0/pipe2/'); do ig="$ig --ignore=${f#h0/}"; done
 (cd h0 && python3 -m pytest -q -p no:cacheprovider -n 6 $ig pipe2) || rc=1
 for f in h0/live/test_*.py h0/squid_live/test_*.py; do
   echo "$skip" | grep -qx "$f" && continue
   (cd "$(dirname "$f")" && python3 -m pytest -q -p no:cacheprovider "$(basename "$f")") || rc=1
 done
 echo $rc >"$logs/py.rc") >"$logs/py" 2>&1 &

ex=""
for f in $(echo "$skip" | grep '^engine/'); do ex="$ex --exclude ${f#engine/}"; done
(cd engine && npx vitest run $ex; echo $? >"$logs/engine.rc") >"$logs/engine" 2>&1 &
wait

# green suites first, red last: the gate's tail is what the player sees
rc=0
for pass in green red; do
  for s in dream make py engine; do
    [ -f "$logs/$s.rc" ] || continue
    c=$(cat "$logs/$s.rc")
    if [ "$c" = 0 ]; then [ $pass = green ] || continue; else [ $pass = red ] || continue; rc=1; fi
    echo "== $s (exit $c)"
    cat "$logs/$s"
  done
done
exit $rc
