#!/bin/bash
# End-to-end smoke test: join 2 players, ready, countdown->live, play to 100%, king+results.
set -u
B=http://localhost:3759
export PORT=3759 DB_PATH=/tmp/e2e.sqlite3
rm -f /tmp/e2e.sqlite3*
setsid node src/server.js </dev/null >/tmp/e2e-server.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
for i in $(seq 1 20); do curl -s -m 2 $B/api/today >/dev/null 2>&1 && break; sleep 0.5; done
fail() { echo "FAIL: $1"; kill $SRV 2>/dev/null; exit 1; }

A=$(curl -s -m 5 -X POST $B/api/rooms/join -H 'content-type: application/json' -d '{"roomCode":"E2E","nickname":"Anna"}') || fail "join Anna"
RACE=$(echo "$A" | python3 -c "import sys,json;print(json.load(sys.stdin)['raceId'])")
AID=$(echo "$A" | python3 -c "import sys,json;print(json.load(sys.stdin)['playerId'])")
BO=$(curl -s -m 5 -X POST $B/api/rooms/join -H 'content-type: application/json' -d '{"roomCode":"E2E","nickname":"Bob Smith"}')
BID=$(echo "$BO" | python3 -c "import sys,json;print(json.load(sys.stdin)['playerId'])")
echo "race=$RACE anna=$AID bob=$BID"

# grid hidden in lobby
G=$(curl -s -m 5 "$B/api/races/$RACE?playerId=$AID" | python3 -c "import sys,json;print(json.load(sys.stdin)['grid'])")
[ "$G" = "None" ] || fail "grid leaked in lobby: $G"
echo "ok: grid hidden in lobby"

curl -s -m 5 -X POST $B/api/races/$RACE/ready -H 'content-type: application/json' -d "{\"playerId\":\"$AID\",\"ready\":true}" > /dev/null
S1=$(curl -s -m 5 "$B/api/races/$RACE?playerId=$AID" | python3 -c "import sys,json;print(json.load(sys.stdin)['race']['status'])")
[ "$S1" = "lobby" ] || fail "should wait for all, got $S1"
echo "ok: waits for all (still lobby after 1 ready)"

curl -s -m 5 -X POST $B/api/races/$RACE/ready -H 'content-type: application/json' -d "{\"playerId\":\"$BID\",\"ready\":true}" > /dev/null
S2=$(curl -s -m 5 "$B/api/races/$RACE?playerId=$AID" | python3 -c "import sys,json;print(json.load(sys.stdin)['race']['status'])")
[ "$S2" = "countdown" ] || fail "expected countdown, got $S2"
echo "ok: countdown starts when all ready"

sleep 6
V=$(curl -s -m 5 "$B/api/races/$RACE?playerId=$AID")
ST=$(echo "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['race']['status'])")
[ "$ST" = "live" ] || fail "expected live, got $ST"
GRID=$(echo "$V" | python3 -c "import sys,json;print(''.join(json.load(sys.stdin)['grid']))")
echo "ok: live, grid=$GRID"

# Anna plays all 10 required words of seed puzzle
for w in THE HUG RUG LUG HURT EAT TEA HAT LAT GUR; do
  R=$(curl -s -m 5 -X POST $B/api/races/$RACE/words -H 'content-type: application/json' -d "{\"playerId\":\"$AID\",\"word\":\"$w\"}")
  OK=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ok'))")
  [ "$OK" = "True" ] || fail "word $w rejected: $R"
done
echo "ok: Anna found 10/10"

# Anna finished -> results unlocked for her, locked for Bob
curl -s -m 5 "$B/api/races/$RACE/results?playerId=$AID" | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['standings'][0]['acronym']=='A',d;print('ok: Anna leads results')"
if curl -s -m 5 "$B/api/races/$RACE/results?playerId=$BID" | grep -q standings; then fail "Bob sees results early"; fi
echo "ok: results locked for unfinished Bob"

# live rank: acronyms only, no counts
RK=$(curl -s -m 5 "$B/api/races/$RACE/rank?playerId=$BID")
echo "$RK" | python3 -c "import sys,json;d=json.load(sys.stdin);assert 'count' not in json.dumps([x for x in d['order'] if x['acronym']=='B']), 'count leaked';print('ok: rank hides counts:', ' > '.join(x['acronym'] for x in d['order']))"

# Bob gives up -> race done
curl -s -m 5 -X POST $B/api/races/$RACE/giveup -H 'content-type: application/json' -d "{\"playerId\":\"$BID\"}" > /dev/null
ST2=$(curl -s -m 5 "$B/api/races/$RACE?playerId=$AID" | python3 -c "import sys,json;print(json.load(sys.stdin)['race']['status'])")
[ "$ST2" = "done" ] || fail "expected done, got $ST2"
curl -s -m 5 "$B/api/rooms/E2E/king" | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['king']['nickname']=='Anna' and d['streak']==1, d;print('ok: king=Anna streak=1')"
curl -s -m 5 "$B/api/races/$RACE/results?playerId=$BID" | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok: hardest words:', [(h['word'],h['foundBy']) for h in d['hardest']][:3])"

kill $SRV 2>/dev/null
echo "E2E PASS"
