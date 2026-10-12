# Squardle Racing — agent notes

Vanilla Node 24 (ESM) + Express + `ws` + built-in `node:sqlite`. No framework, no ORM. One process serves API + WS + static `public/`.

## Commands

- `npm install` / `npm start` (port `3000`, `PORT`/`DB_PATH`/`NO_FETCH` env)
- `npm test` — unit (`test/*.test.js`, `node:test`)
- `bash test-e2e.sh` — full race flow (temp server+DB, `NO_FETCH=1`)
- `node test-ws.mjs <port>` — WS lobby-broadcast check
- `bash test-stale.sh` — stale-race reroute check
- `npm run fetch` — pull official puzzles into default `./data`

## Layout

- `src/server.js` — API + WS + race state machine (`lobby→countdown→live→done`)
- `src/ingest.js` — official fetch (`squaredle.app/?level=xp` → `today-puzzle-config.js`, rot-N decode), `currentPuzzleDate()`; `src/calendar.js` handles 03:00 Pacific rollover and DST
- `src/words.js` — 3x3 path validation (8-dir, no reuse, min 3)
- `src/db.js` — schema + `acronymFor`
- `public/` — vanilla UI: drag/swipe only (no typing), acronym-only live rank

## Rules that burned us before

1. **Daily rollover**: use the later of the 03:00 Pacific calendar and a successfully fetched official today date in this process; never select today from a stale persisted fetch date. Expire unfinished races at the next calendar rollover; clients compare race `currentDate` on every sync so open tabs move to the published board too. Per-player `started_at` clocks survive reconnects; new live/done joiners start their own clock.
2. **Race date pinning**: races lock `puzzle_date` at creation. Boot must `refreshOfficialPuzzles()` (blocking) before `listen`; clients must reroute stale stored `raceId`s (see resume in `app.js`).
3. **Broadcast on every mutation** (`tickAndBroadcast`): joins/ready-toggles rarely change status but all sockets need refresh. WS snapshot on connect required.
4. **No count leaks**: `/rank` and WS omit word counts while live (acronyms only); `/results` 403s until requester finishes or race done.
5. **Auto-fetch never overwrites raced dates** (`overwrite:false`); only untouched `seed-sample` rows in `lobby` races. Admin save always overwrites.
6. **Seed words must all have grid paths** — verify with `findPath` when touching the seed.
7. Tests use throwaway DBs (`/tmp/*.sqlite3`, `NO_FETCH=1`); never commit `data/*` (gitignored) or `node_modules`.
