# ⚡ Squaredle Express Racing

Race the daily **Squaredle Express** (3×3) with friends — in the browser, on phone or desktop.

- One race per day, same official puzzle for everyone
- Lobby → everyone presses **Ready** → synced **countdown** → grid reveals for all at once
- Play the grid in-app with drag/swipe gestures (like the original); first to **100% of required words** is crowned **👑 King**
- **Live ranking shows acronym order only** (no word counts, no spoilers)
- No timeouts: the race stays open until everyone finishes or gives up
- Stats: lead changes, hardest words (fewest finders / slowest), first-finder per word
- Share card: `👑 I have been crowned King of Squaredle Express …`

## Run (free, no accounts)

Needs Node 22+ (uses built-in SQLite, no DB to install).

```bash
npm install
npm start        # http://localhost:3000
```

Open the URL on your phone (same Wi-Fi) or deploy anywhere Node runs.
Invite link format: `http://your-host/?room=KINGS`.

## Daily puzzle

The official Squaredle site has **no public API**, but it publishes its puzzle
bundle (`/api/today-puzzle-config.js`). The server fetches it on startup and
every 6h, decoding the real board + word lists and following the site's own
calendar for "today". If the site format changes, use **Admin: puzzle setup**
in the footer to paste the 9-letter grid + word lists manually.

The grid is hidden from the API until the countdown hits zero, so early joiners can't peek.

## How a race goes

1. Everyone joins with room code (default `KINGS`) + nickname.
2. Everyone presses `I'm Ready`. **All** must be ready (late join drops countdown back to lobby).
3. 5-second server-synced countdown → `GO`, grid unblurs for everyone.
4. Live strip shows running order as acronym chips (`1. AK › 2. JM`), no counts.
5. First to 100% becomes King; completed racers are ranked by finish time. Results show each player's all-time wins in the room alongside their race stats.
6. Your full results + counts unlock when *you* finish; group table when the race closes.

## Tests

```bash
npm test          # unit tests (grid paths, validation, race rules)
bash test-e2e.sh  # full race flow against a temp server + temp DB
```

## Free hosting later

- Frontend + backend are one Node process: deploy to Render/Fly.io free tier, or `node src/server.js` on any always-on machine.
- To move to Supabase/Vercel later, only `src/db.js` + the WS layer need swapping; the API shape stays.
