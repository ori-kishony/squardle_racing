import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, acronymFor } from "./db.js";
import { validateWord, gridHintCounts, hintThresholds } from "./words.js";
import {
  getPuzzle,
  ensurePuzzleFor,
  currentPuzzleDate,
  refreshOfficialPuzzles,
  savePuzzle,
} from "./ingest.js";

const COUNTDOWN_MS = 5000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

// Health check for Render/Fly/Railway (no DB write, just readability).
app.get("/healthz", (req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- helpers ----------
const now = () => Date.now();
const getRace = (id) => db.prepare("SELECT * FROM races WHERE id = ?").get(id);
const racePlayers = (raceId) =>
  db
    .prepare(
      `SELECT p.id, p.nickname, p.acronym, rp.ready, rp.finished_at AS finishedAt, rp.gave_up AS gaveUp
       FROM race_players rp JOIN players p ON p.id = rp.player_id WHERE rp.race_id = ?`
    )
    .all(raceId);
const foundCount = (raceId, playerId) =>
  db
    .prepare("SELECT COUNT(*) AS n FROM finds WHERE race_id = ? AND player_id = ?")
    .get(raceId, playerId).n;
const lastFindAt = (raceId, playerId) =>
  db
    .prepare("SELECT MAX(found_at) AS t FROM finds WHERE race_id = ? AND player_id = ?")
    .get(raceId, playerId).t ?? 0;

function rankOrder(race) {
  const players = racePlayers(race.id);
  const stats = players.map((p) => ({
    ...p,
    count: foundCount(race.id, p.id),
    lastAt: lastFindAt(race.id, p.id),
  }));
  const finished = stats
    .filter((p) => p.finishedAt)
    .sort((a, b) => a.finishedAt - b.finishedAt);
  const unfinished = stats
    .filter((p) => !p.finishedAt)
    .sort((a, b) => b.count - a.count || a.lastAt - b.lastAt);
  return [...finished, ...unfinished];
}

/** State machine. Returns true if status changed. */
function tickRace(race) {
  const t = now();
  if (race.status === "countdown" && race.starts_at && t >= race.starts_at) {
    db.prepare("UPDATE races SET status = 'live' WHERE id = ?").run(race.id);
    return true;
  }
  if (race.status === "countdown" || race.status === "lobby") {
    const players = racePlayers(race.id);
    const allReady =
      players.length >= 2 && players.every((p) => p.ready === 1);
    if (race.status === "lobby" && allReady) {
      db.prepare("UPDATE races SET status = 'countdown', starts_at = ? WHERE id = ?")
        .run(t + COUNTDOWN_MS, race.id);
      return true;
    }
    if (race.status === "countdown" && !allReady) {
      db.prepare("UPDATE races SET status = 'lobby', starts_at = NULL WHERE id = ?")
        .run(race.id);
      return true;
    }
  }
  if (race.status === "live" || race.status === "countdown") {
    const players = racePlayers(race.id);
    if (players.length > 0 && players.every((p) => p.finishedAt || p.gaveUp)) {
      db.prepare("UPDATE races SET status = 'done' WHERE id = ?").run(race.id);
      return true;
    }
  }
  return false;
}

function tickAndBroadcast(raceId) {
  // Always broadcast: joins/ready-toggles often change nothing about status,
  // but every client (esp. the first joiner) must still refresh.
  const race = getRace(raceId);
  if (!race) return;
  tickRace(race);
  broadcast(raceId);
}

// ---------- probabilities: one race per room per day ----------
function getOrCreateRace(roomCode, date) {
  ensurePuzzleFor(date);
  let race = db
    .prepare("SELECT * FROM races WHERE room_code = ? AND puzzle_date = ?")
    .get(roomCode, date);
  if (!race) {
    race = {
      id: randomUUID(),
      room_code: roomCode,
      puzzle_date: date,
      status: "lobby",
      starts_at: null,
      created_at: now(),
    };
    db.prepare(
      "INSERT INTO races (id, room_code, puzzle_date, status, starts_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(race.id, race.room_code, race.puzzle_date, race.status, race.starts_at, race.created_at);
  }
  return getRace(race.id);
}

// ---------- API ----------
app.get("/api/today", (req, res) => {
  const date = currentPuzzleDate();
  const p = ensurePuzzleFor(date);
  res.json({ date, requiredCount: p.required.length, bonusCount: p.bonus.length, source: p.source });
});

app.post("/api/rooms/join", (req, res) => {
  const roomCode = String(req.body?.roomCode || "KINGS").trim().toUpperCase().slice(0, 12) || "KINGS";
  const nickname = String(req.body?.nickname || "").trim().slice(0, 24);
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  db.prepare("INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING")
    .run(roomCode, roomCode, now());
  // Reuse player by nickname in room, else create.
  let player = db.prepare("SELECT * FROM players WHERE room_code = ? AND nickname = ?").get(roomCode, nickname);
  if (!player) {
    player = { id: randomUUID(), room_code: roomCode, nickname, acronym: acronymFor(nickname), token: randomUUID(), created_at: now() };
    db.prepare("INSERT INTO players (id, room_code, nickname, acronym, token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(player.id, player.room_code, player.nickname, player.acronym, player.token, player.created_at);
  }
  const date = currentPuzzleDate();
  const race = getOrCreateRace(roomCode, date);
  db.prepare("INSERT INTO race_players (race_id, player_id, ready) VALUES (?, ?, 0) ON CONFLICT DO NOTHING")
    .run(race.id, player.id);
  tickAndBroadcast(race.id);
  res.json({ roomCode, playerId: player.id, token: player.token, raceId: race.id, date });
});

function raceView(raceId, playerId) {
  let race = getRace(raceId);
  if (!race) return null;
  tickRace(race);
  race = getRace(raceId);
  const puzzle = getPuzzle(race.puzzle_date);
  const players = racePlayers(raceId);
  const me = players.find((p) => p.id === playerId);
  const myWords = playerId
    ? db.prepare("SELECT word, found_at AS foundAt, is_bonus AS isBonus FROM finds WHERE race_id = ? AND player_id = ? ORDER BY found_at").all(raceId, playerId)
    : [];
  const meFinished = !!me?.finishedAt;
  const reveal = race.status === "done" || meFinished;
  // Grid stays secret until GO (or for finished viewers).
  const grid = race.status === "live" || reveal ? puzzle.grid : null;
  const reqUpper = puzzle.required.map((w) => String(w).toUpperCase());
  const reqSet = new Set(reqUpper);
  const foundWords = myWords.map((w) => w.word);
  const foundSet = new Set(foundWords);
  const bonusSet = new Set((puzzle.bonus || []).map((w) => String(w).toUpperCase()));
  const myBonus = foundWords.filter((w) => bonusSet.has(w) && !reqSet.has(w));
  const requiredFound = foundWords.filter((w) => reqSet.has(w)).length;
  // Progressive hints + fade, computed only when the grid is visible.
  // Counts cover REQUIRED words only (bonus excluded, like the original perks)
  // so no missing-word info leaks beyond per-cell totals.
  let hints = null;
  let faded = null;
  if (grid) {
    const { wordStarts, wordUses } = gridHintCounts(puzzle.grid, reqUpper);
    const { startAt, useAt } = hintThresholds(reqUpper.length);
    const startUnlocked = requiredFound >= startAt;
    const useUnlocked = requiredFound >= useAt;
    // Counts cover only words you have NOT found yet, so they tick down
    // as you play (like the original). Bonus words never counted.
    const startCounts = Array(9).fill(0);
    const useCounts = Array(9).fill(0);
    for (let k = 0; k < reqUpper.length; k++) {
      if (foundSet.has(reqUpper[k])) continue;
      for (const c of wordStarts[k]) startCounts[c]++;
      for (const c of wordUses[k]) useCounts[c]++;
    }
    hints = {
      startAt,
      useAt,
      startUnlocked,
      useUnlocked,
      // Counts released only once unlocked (progressive, like the original).
      startCounts: startUnlocked ? startCounts : null,
      useCounts: useUnlocked ? useCounts : null,
    };
    // A square fades once YOU found every required word using it (original rule).
    faded = Array(9).fill(false);
    for (let i = 0; i < 9; i++) {
      let uses = 0, found = 0;
      for (let k = 0; k < reqUpper.length; k++) {
        if (wordUses[k].has(i)) {
          uses++;
          if (foundSet.has(reqUpper[k])) found++;
        }
      }
      faded[i] = uses > 0 && found === uses;
    }
  }
  return {
    race: { id: race.id, roomCode: race.room_code, date: race.puzzle_date, status: race.status, startsAt: race.starts_at, serverNow: now() },
    players: players.map((p) => ({
      playerId: p.id, nickname: p.nickname, acronym: p.acronym,
      ready: p.ready === 1, finished: !!p.finishedAt, gaveUp: p.gaveUp === 1,
    })),
    grid,
    requiredCount: puzzle.required.length,
    bonusCount: puzzle.bonus.length,
    myWords: foundWords,
    myBonus,
    requiredFound,
    hints,
    faded,
    myFinished: meFinished,
    myReady: me?.ready === 1,
  };
}

app.get("/api/races/:id", (req, res) => {
  const v = raceView(req.params.id, String(req.query.playerId || ""));
  if (!v) return res.status(404).json({ error: "race not found" });
  res.json(v);
});

app.post("/api/races/:id/ready", (req, res) => {
  const race = getRace(req.params.id);
  if (!race) return res.status(404).json({ error: "race not found" });
  if (race.status === "live" || race.status === "done")
    return res.status(409).json({ error: "race already started" });
  const { playerId, ready } = req.body || {};
  const row = db.prepare("SELECT * FROM race_players WHERE race_id = ? AND player_id = ?").get(race.id, playerId);
  if (!row) return res.status(404).json({ error: "player not in race" });
  db.prepare("UPDATE race_players SET ready = ? WHERE race_id = ? AND player_id = ?")
    .run(ready ? 1 : 0, race.id, playerId);
  tickAndBroadcast(race.id);
  res.json(raceView(race.id, playerId));
});

app.post("/api/races/:id/words", (req, res) => {
  let race = getRace(req.params.id);
  if (!race) return res.status(404).json({ error: "race not found" });
  tickRace(race);
  race = getRace(req.params.id);
  if (race.status !== "live") return res.status(409).json({ error: "race not live" });
  const { playerId, word } = req.body || {};
  const rp = db.prepare("SELECT * FROM race_players WHERE race_id = ? AND player_id = ?").get(race.id, playerId);
  if (!rp) return res.status(404).json({ error: "player not in race" });
  if (rp.finished_at || rp.gave_up) return res.status(409).json({ error: "already finished" });
  const puzzle = getPuzzle(race.puzzle_date);
  const already = new Set(
    db.prepare("SELECT word FROM finds WHERE race_id = ? AND player_id = ?").all(race.id, playerId).map((r) => r.word)
  );
  const v = validateWord({ grid: puzzle.grid, required: puzzle.required, bonus: puzzle.bonus, word, alreadyFound: already });
  if (!v.ok) return res.json({ ok: false, reason: v.reason });
  const t = now();
  db.prepare("INSERT INTO finds (race_id, player_id, word, found_at, is_bonus) VALUES (?, ?, ?, ?, ?)")
    .run(race.id, playerId, v.word, t, v.isBonus ? 1 : 0);
  // Finish = 100% of REQUIRED words (bonus excluded).
  const reqSet = new Set(puzzle.required.map((w) => w.toUpperCase()));
  const mine = db.prepare("SELECT word FROM finds WHERE race_id = ? AND player_id = ?").all(race.id, playerId).map((r) => r.word);
  const doneCount = mine.filter((w) => reqSet.has(w)).length;
  let finished = false;
  if (doneCount >= reqSet.size) {
    db.prepare("UPDATE race_players SET finished_at = ? WHERE race_id = ? AND player_id = ?").run(t, race.id, playerId);
    finished = true;
    // Crown king: first finisher of this race.
    const existing = db.prepare("SELECT * FROM king_history WHERE room_code = ? AND race_id = ?").get(race.room_code, race.id);
    if (!existing) {
      db.prepare("INSERT INTO king_history (room_code, player_id, race_id, won_at) VALUES (?, ?, ?, ?)")
        .run(race.room_code, playerId, race.id, t);
    }
  }
  tickAndBroadcast(race.id);
  res.json({ ok: true, word: v.word, isBonus: v.isBonus, path: v.path, finished, requiredFound: doneCount, requiredTotal: reqSet.size });
});

app.post("/api/races/:id/giveup", (req, res) => {
  const race = getRace(req.params.id);
  if (!race) return res.status(404).json({ error: "race not found" });
  const { playerId } = req.body || {};
  db.prepare("UPDATE race_players SET gave_up = 1 WHERE race_id = ? AND player_id = ?").run(race.id, playerId);
  tickAndBroadcast(race.id);
  res.json(raceView(race.id, playerId));
});

// Live ranking: acronym order ONLY while live (no counts) — per spec.
app.get("/api/races/:id/rank", (req, res) => {
  let race = getRace(req.params.id);
  if (!race) return res.status(404).json({ error: "race not found" });
  tickRace(race);
  race = getRace(req.params.id);
  const order = rankOrder(race);
  const playerId = String(req.query.playerId || "");
  const me = racePlayers(race.id).find((p) => p.id === playerId);
  const reveal = race.status === "done" || !!me?.finishedAt;
  res.json({
    status: race.status,
    order: order.map((p) => ({
      playerId: p.id, acronym: p.acronym, nickname: p.nickname,
      finished: !!p.finishedAt, gaveUp: p.gaveUp === 1,
      ...(reveal ? { count: p.count } : {}),
    })),
  });
});

app.get("/api/races/:id/results", (req, res) => {
  let race = getRace(req.params.id);
  if (!race) return res.status(404).json({ error: "race not found" });
  tickRace(race);
  race = getRace(req.params.id);
  const playerId = String(req.query.playerId || "");
  const me = racePlayers(race.id).find((p) => p.id === playerId);
  if (race.status !== "done" && !me?.finishedAt)
    return res.status(403).json({ error: "results unlock when you finish or the race ends" });
  const puzzle = getPuzzle(race.puzzle_date);
  const order = rankOrder(race);
  const startMs = race.starts_at;
  // Per-word difficulty: found-by count, avg time, first finder.
  const wordStats = puzzle.required.map((word) => {
    const rows = db.prepare("SELECT player_id AS pid, found_at AS t FROM finds WHERE race_id = ? AND word = ? ORDER BY found_at").all(race.id, word);
    const playerCount = racePlayers(race.id).length || 1;
    return {
      word,
      foundBy: rows.length,
      totalPlayers: playerCount,
      avgMs: rows.length ? Math.round(rows.reduce((s, r) => s + (r.t - startMs), 0) / rows.length) : null,
      firstBy: rows[0] ? racePlayers(race.id).find((p) => p.id === rows[0].pid)?.acronym : null,
    };
  }).sort((a, b) => a.foundBy - b.foundBy || (b.avgMs ?? 0) - (a.avgMs ?? 0));
  // Lead-change timeline from find events.
  const events = db.prepare("SELECT player_id AS pid, found_at AS t FROM finds WHERE race_id = ? ORDER BY found_at").all(race.id);
  const counts = new Map();
  const timeline = [];
  let leader = null;
  for (const e of events) {
    counts.set(e.pid, (counts.get(e.pid) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (top !== leader) {
      leader = top;
      timeline.push({ atMs: e.t - startMs, leader: racePlayers(race.id).find((p) => p.id === leader)?.acronym });
    }
  }
  res.json({
    status: race.status,
    standings: order.map((p, i) => ({
      rank: i + 1, playerId: p.id, nickname: p.nickname, acronym: p.acronym,
      count: p.count, requiredTotal: puzzle.required.length,
      finishedMs: p.finishedAt ? p.finishedAt - startMs : null, gaveUp: p.gaveUp === 1,
    })),
    hardest: wordStats.slice(0, Math.min(5, wordStats.length)),
    wordStats,
    leadTimeline: timeline,
    date: race.puzzle_date,
  });
});

app.get("/api/rooms/:code/king", (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const last = db.prepare("SELECT * FROM king_history WHERE room_code = ? ORDER BY won_at DESC LIMIT 1").get(code);
  if (!last) return res.json({ king: null });
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(last.player_id);
  // Streak = consecutive race wins by same player, walking back.
  const wins = db.prepare("SELECT * FROM king_history WHERE room_code = ? ORDER BY won_at DESC").all(code);
  let streak = 0;
  for (const w of wins) {
    if (w.player_id === last.player_id) streak++;
    else break;
  }
  const reignDays = Math.max(1, Math.ceil((now() - last.won_at) / 86400000));
  res.json({ king: { nickname: player.nickname, acronym: player.acronym, playerId: player.id }, streak, reignDays, wonAt: last.won_at });
});

// Admin: manual puzzle entry (fallback) + triggered auto-fetch.
app.post("/api/admin/puzzles", (req, res) => {
  const { date, grid, required, bonus } = req.body || {};
  if (!date || !Array.isArray(grid) || grid.length !== 9 || !Array.isArray(required) || !required.length)
    return res.status(400).json({ error: "need {date, grid[9], required[]}" });
  savePuzzle({ date, grid, required, bonus: bonus || [], source: "manual" });
  res.json({ ok: true, puzzle: getPuzzle(date) });
});
app.post("/api/admin/fetch", async (req, res) => {
  try {
    const r = await refreshOfficialPuzzles();
    res.json({ ok: true, officialToday: r.officialToday, count: r.count, puzzle: getPuzzle(r.officialToday) });
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

app.use(express.static(join(root, "public")));

// ---------- WebSocket live updates ----------
const socketsByRace = new Map();
function snapshot(raceId) {
  const race = getRace(raceId);
  if (!race) return null;
  const order = rankOrder(race).map((p) => ({ playerId: p.id, acronym: p.acronym }));
  return JSON.stringify({ type: "race", status: race.status, startsAt: race.starts_at, serverNow: now(), order });
}
function broadcast(raceId) {
  const set = socketsByRace.get(raceId);
  if (!set) return;
  const msg = snapshot(raceId);
  if (!msg) return;
  for (const ws of set) {
    try { ws.send(msg); } catch { /* dead socket */ }
  }
}

async function boot() {
  // Resolve today's REAL puzzle before anyone can join, so the first race
  // of the day is never pinned to a stale fallback date.
  if (!process.env.NO_FETCH) {
    try {
      const r = await refreshOfficialPuzzles();
      console.log(`official puzzles: ${r.count}, today=${r.officialToday}`);
    } catch (err) {
      console.warn("official fetch failed, using stored puzzle:", err.message);
    }
    setInterval(() => {
      refreshOfficialPuzzles().catch(() => {});
    }, 6 * 3600 * 1000);
  }
  ensurePuzzleFor(currentPuzzleDate());
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`squardle racing on http://localhost:${port}`);
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://x");
  const raceId = u.searchParams.get("raceId");
  if (!raceId) return ws.close();
  if (!socketsByRace.has(raceId)) socketsByRace.set(raceId, new Set());
  socketsByRace.get(raceId).add(ws);
  try { ws.send(snapshot(raceId)); } catch { /* ignore */ }
  tickAndBroadcast(raceId);
  ws.on("close", () => socketsByRace.get(raceId)?.delete(ws));
});

// Countdown/done ticker: tick lobby+countdown+live races 2x/sec.
setInterval(() => {
  const races = db.prepare("SELECT * FROM races WHERE status IN ('lobby','countdown','live')").all();
  for (const r of races) {
    const before = r.status + "|" + r.starts_at;
    tickRace(r);
    const after = getRace(r.id);
    if (after.status + "|" + after.starts_at !== before) broadcast(r.id);
  }
}, 500);

boot();
