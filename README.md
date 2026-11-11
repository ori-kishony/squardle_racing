# ⚡ Squaredle Express Racing

Play daily **Squaredle Express** and **regular Squaredle** with friends, on phone or desktop.

- **Express is the default.** It keeps the lobby → Ready → synchronized countdown flow.
- **Regular opens immediately**, even when playing alone. Select its tab after joining your room/profile.
- Tabs share your room and nickname, remember your selection, and resume separate progress.
- Each mode has its own daily standings, crown, cumulative wins, and Yesterday history.
- The fastest completion of all required words earns the crown; a faster later finisher can take it.
- Your clock starts on first joining the puzzle and includes time away. Reconnecting or switching modes never resets it.
- Live rankings show names only. Full stats and word results unlock after finishing, giving up, or daily expiry.
- Both modes support drag/swipe, progressive hints, definitions, and results review.

## Run (free, no accounts)

Use Node 24+ (uses built-in SQLite, no DB to install).

```bash
npm install
npm start        # http://localhost:3000
```

Open the URL on your phone (same Wi-Fi) or deploy anywhere Node runs.
Invite links: `http://your-host/?room=KINGS&mode=express` or `?room=KINGS&mode=regular`. Omitting mode uses Express for new users; returning users resume their saved selection.

## Daily puzzle

The official Squaredle site has **no public API**, but it publishes its puzzle
bundle (`/api/today-puzzle-config.js`). The server fetches it on startup and
at the 03:00 Pacific daily rollover, and 20 seconds after each hour, decoding
both modes’ real boards and word lists. These checks follow the wall clock, independent
of server startup time. A freshly fetched
published date takes precedence when it is ahead of the calculated 03:00
Pacific calendar; a stale saved fetch date never holds the game on yesterday.
Open tabs and saved sessions move to today’s puzzle in the selected mode automatically, retrying if
the new puzzle is temporarily unavailable. If the site format changes, use **Admin: puzzle setup**
in the footer to enter the selected mode’s grid and word lists manually. Use `.` for a blank cell in a square grid.

Express hides its grid until the countdown hits zero. Regular reveals its grid on joining. Automatic refresh never replaces a played puzzle. Existing databases and browser sessions migrate to Express, retaining profiles, progress, results, and crowns.

## API modes

`POST /api/rooms/join` accepts `mode` in its JSON body. `/api/today`,
`/api/rooms/:code/history`, and `/api/rooms/:code/king` accept `?mode=regular`
or `?mode=express`; omitted modes default to Express. Race URLs use the race’s
stored mode. Admin save and fetch accept `mode` in their JSON bodies.

## Tests

```bash
npm test              # unit/API tests, migration, mode isolation, clocks and crowns
bash test-e2e.sh      # existing Express countdown-to-results smoke test
npm run test:browser  # desktop/phone Chrome checks, temp DB/profile/screenshots
```

Browser checks use `/opt/google/chrome/chrome` by default; set `CHROME_PATH` to another Chrome binary. All checks use isolated databases.

## Free hosting later

- Frontend + backend are one Node process: deploy to Render/Fly.io free tier, or `node src/server.js` on any always-on machine.
- To move to Supabase/Vercel later, only `src/db.js` + the WS layer need swapping; the API shape stays.
