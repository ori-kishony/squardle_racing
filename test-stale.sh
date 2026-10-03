#!/bin/bash
# Reproduces the stale-race scenario: join before the official fetch lands,
# then re-join after -> must be routed to the official puzzle, old race untouched.
set -u
export PORT=3758 DB_PATH=/tmp/stale.sqlite3 NO_FETCH=1
rm -f /tmp/stale.sqlite3*
setsid node src/server.js </dev/null >/tmp/stale.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
B=http://localhost:3758
for i in $(seq 1 20); do curl -s -m 2 $B/api/today >/dev/null 2>&1 && break; sleep 0.5; done
fail() { echo "FAIL: $1"; kill $SRV 2>/dev/null; exit 1; }

J1=$(curl -s -m 5 -X POST $B/api/rooms/join -H 'content-type: application/json' -d '{"roomCode":"STALE","nickname":"Zed"}')
D1=$(echo "$J1" | python3 -c "import sys,json;print(json.load(sys.stdin)['date'])")
echo "joined pre-fetch on date=$D1 (fallback, expected)"

# official fetch lands late (real network)
DB_PATH=/tmp/stale.sqlite3 node -e "import('./src/ingest.js').then(async m=>{const r=await m.refreshOfficialPuzzles();console.log('refresh:',JSON.stringify(r))})" || fail "refresh crashed"

J2=$(curl -s -m 5 -X POST $B/api/rooms/join -H 'content-type: application/json' -d '{"roomCode":"STALE","nickname":"Zed"}')
D2=$(echo "$J2" | python3 -c "import sys,json;print(json.load(sys.stdin)['date'])")
R2=$(echo "$J2" | python3 -c "import sys,json;print(json.load(sys.stdin)['raceId'])")
[ "$D2" = "2026-10-04" ] || fail "re-join routed to $D2 instead of official 2026-10-04"
P2=$(echo "$J2" | python3 -c "import sys,json;print(json.load(sys.stdin)['playerId'])")
G2=$(curl -s -m 5 "$B/api/races/$R2/ready" >/dev/null 2>&1; curl -s -m 5 "$B/api/races/$R2?playerId=$P2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(''.join(d['grid'] or ['HIDDEN']))")
echo "post-fetch re-join: date=$D2 grid=$G2"
[ "$D1" != "$D2" ] && echo "ok: stale lobby race no longer served to re-joining player"
kill $SRV 2>/dev/null
echo "STALE-TEST DONE"
