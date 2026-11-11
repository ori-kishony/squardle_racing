// Daily puzzle ingest: fetches the official Express and Regular puzzles.
//
// The official site has no public API, but it publishes its puzzle data in
// `/api/today-puzzle-config.js` (referenced from `/?level=xp`). Word lists
// are obfuscated with a char-substitution + base64; the substitution alphabet
// and rotation are extracted live from the bundled closure-*.js so this
// keeps working across redeploys. The daily calendar uses the official
// 03:00 Pacific rollover; cached config dates cannot freeze today's rooms.
import { puzzleMode, minimumWordLength } from "./modes.js";
import { db } from "./db.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPath } from "./words.js";
import { prefetchDefinitions } from "./definitions.js";
import { puzzleDateAt } from "./calendar.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = { "User-Agent": "squardle-racing (friends-group, few req/day)" };

export function todayDateUTC() {
  return new Date().toISOString().slice(0, 10);
}

function officialTodayPath() {
  return process.env.OFFICIAL_TODAY_PATH || join(root, "data", "official-today.json");
}

export function getOfficialToday() {
  try {
    if (existsSync(officialTodayPath()))
      return JSON.parse(readFileSync(officialTodayPath(), "utf8")).date;
  } catch { /* ignore */ }
  return null;
}

function setOfficialToday(date) {
  mkdirSync(dirname(officialTodayPath()), { recursive: true });
  writeFileSync(officialTodayPath(), JSON.stringify({ date }));
}

// Only a successful fetch in this process can override the calculated calendar.
// The publisher can already be serving its next board; a stale disk pointer
// must never hold rooms on yesterday when the official fetch is unavailable.
const fetchedOfficialToday = new Map();
export function currentPuzzleDate(mode = "express") {
  const fetchedDate = fetchedOfficialToday.get(puzzleMode(mode));
  const calendarDate = puzzleDateAt();
  return fetchedDate && fetchedDate > calendarDate
    ? fetchedDate : calendarDate;
}

async function get(url) {
  const res = await fetch(url, { headers: { ...UA, "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function extractDecoderClosures(html) {
  const m = html.match(/<script[^>]+src="([^"]*closure-[^"]*\.js)"/);
  if (!m) throw new Error("closure bundle not found in HTML");
  const js = await get(new URL(m[1], "https://squaredle.app/").toString());
  return decoderFromBundle(js);
}

export function decoderFromBundle(js) {
  // Capture identifiers: Closure renamed the index variable from p to n.
  const fn = js.match(/(\w+)=function\((\w+)\)\{var (\w+)=(\w+)\.indexOf\(\2\);return-1==\3\?\2:\4\[\(\3-(\d+)\+\4\.length\)%\4\.length\]\}/);
  if (!fn) throw new Error("decoder function not found in bundle");
  const rot = Number(fn[5]);
  const alphas = [...js.matchAll(/"([A-Za-z0-9]{60,70})"/g)].map((x) => x[1]);
  // The alphabet is the 62-char base64-ish custom set; pick the one that decodes.
  return { js, rot, alphas };
}

function tryDecode(field, alpha, rot) {
  const mapped = [...field]
    .map((ch) => {
      const p = alpha.indexOf(ch);
      return p === -1 ? ch : alpha[(p - rot + alpha.length) % alpha.length];
    })
    .join("");
  return Buffer.from(mapped, "base64").toString("utf8");
}

export function parsePuzzleConfig(scriptText, alphas, rot) {
  const i = scriptText.indexOf("const gPuzzleConfig = ");
  if (i === -1) throw new Error("gPuzzleConfig not found");
  const j = scriptText.indexOf(";\n", i);
  const cfg = JSON.parse(scriptText.slice(i + "const gPuzzleConfig = ".length, j));
  const todayMatch = scriptText.match(/gTodayDateStr\s*=\s*'(\d{4})\/(\d{2})\/(\d{2})'/);
  const officialToday = todayMatch
    ? `${todayMatch[1]}-${todayMatch[2]}-${todayMatch[3]}`
    : null;
  const out = [];
  for (const [key, e] of Object.entries(cfg.puzzles || {})) {
    if (!/^\d{4}\/\d{2}\/\d{2}(-xp)?$/.test(key) || !Array.isArray(e.board)) continue;
    const mode = key.endsWith("-xp") ? "express" : "regular";
    const date = key.slice(0, 10).replaceAll("/", "-");
    const size = e.board.length;
    if (!size || !e.board.every(row => typeof row === "string" && row.length === size)) continue;
    const grid = e.board.join("").toUpperCase().split("").map(c => /^[A-Z]$/.test(c) ? c : "");
    if (mode === "express" && grid.length !== 9) continue;
    const wordPattern = new RegExp(`^[a-z]{${minimumWordLength(mode)},${grid.length}}$`);
    let required = null, bonus = [];
    for (const alpha of alphas) {
      try {
        const req = tryDecode(e.wordScores || "", alpha, rot).split(",").filter(Boolean);
        const bon = tryDecode(e.optionalWordScores || "", alpha, rot).split(",").filter(Boolean);
        // Sanity: decoded words must fit the mode and board.
        if (req.length >= 5 && req.every((w) => wordPattern.test(w))) {
          required = req.map((w) => w.toUpperCase());
          bonus = bon.filter((w) => wordPattern.test(w)).map((w) => w.toUpperCase());
          break;
        }
      } catch { /* try next alphabet */ }
    }
    if (!required) {
      console.warn(`could not decode words for ${key}; keeping this mode's stored puzzle`);
      continue;
    }
    out.push({ date, mode, grid, required, bonus });
  }
  return { puzzles: out, officialToday };
}

export async function fetchOfficialPuzzles() {
  const html = await get("https://squaredle.app/?level=xp");
  const cfgMatch = html.match(/<script[^>]+src="([^"]*today-puzzle-config\.js)"/);
  if (!cfgMatch) throw new Error("today-puzzle-config.js not found in HTML");
  const cfgUrl = new URL(cfgMatch[1], "https://squaredle.app/").toString();
  const [cfgText, { alphas, rot }] = await Promise.all([
    get(cfgUrl),
    extractDecoderClosures(html),
  ]);
  return parsePuzzleConfig(cfgText, alphas, rot);
}

export async function fetchOfficialExpress() {
  const result = await fetchOfficialPuzzles();
  return { ...result, puzzles: result.puzzles.filter(p => p.mode === "express") };
}

export function savePuzzle({ date, mode = "express", grid, required, bonus = [], source }) {
  puzzleMode(mode);
  const problems = required.filter(
    (w) => !findPath(grid.map((c) => String(c).toUpperCase()), w)
  );
  if (problems.length)
    console.warn(`puzzle ${date}: ${problems.length} required words have no grid path: ${problems.join(",")}`);
  insertPuzzle({ date, mode, grid, required, bonus, source, overwrite: true });
  void prefetchDefinitions([...required, ...bonus]);
}

function insertPuzzle({ date, mode = "express", grid, required, bonus = [], source, overwrite }) {
  if (!overwrite) {
    const existing = getPuzzle(date, mode);
    if (existing) {
      // Never clobber a real/manual puzzle underneath a room that may be racing it.
      if (existing.source !== "seed-sample") return "kept";
      // A seed row may only be upgraded while its races haven't started
      // (lobby = grid never revealed, no finds possible yet).
      const started = db
        .prepare(
          `SELECT 1 FROM races WHERE puzzle_date = ? AND mode = ? AND status != 'lobby' LIMIT 1`
        )
        .get(date, mode);
      if (started) return "kept";
    }
  }
  db.prepare(
    `INSERT INTO puzzles (date, mode, grid, required, bonus, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, mode) DO UPDATE SET grid=excluded.grid, required=excluded.required,
       bonus=excluded.bonus, source=excluded.source`
  ).run(
    date, mode,
    JSON.stringify(grid.map((c) => String(c).toUpperCase())),
    JSON.stringify(required.map((w) => w.toUpperCase())),
    JSON.stringify(bonus.map((w) => w.toUpperCase())),
    source
  );
}

export function getPuzzle(date, mode = "express") {
  const row = db.prepare("SELECT * FROM puzzles WHERE date = ? AND mode = ?").get(date, puzzleMode(mode));
  if (!row) return null;
  return {
    date: row.date,
    mode: row.mode,
    grid: JSON.parse(row.grid),
    required: JSON.parse(row.required),
    bonus: JSON.parse(row.bonus),
    source: row.source,
  };
}

export function ensurePuzzleFor(date, mode = "express") {
  puzzleMode(mode);
  if (getPuzzle(date, mode)) return getPuzzle(date, mode);
  if (!process.env.NO_FETCH) throw new Error(`Official puzzle for ${date} is not available yet. Please retry shortly.`);
  // Offline fallback so the app is playable before the first successful scrape.
  const seed = {
    date,
    grid: ["T", "E", "T", "A", "H", "R", "L", "U", "G"],
    required: ["THE", "HUG", "RUG", "LUG", "HURT", "EAT", "TEA", "HAT", "LAT", "GUR"],
    bonus: ["RUL", "LUR", "RUA", "UGH"],
    source: "seed-sample",
  };
  if (mode === "regular") {
    seed.mode = mode;
    seed.grid = ["T", "E", "S", "T", "A", "H", "R", "S", "L", "U", "G", "E", "B", "O", "N", "D"];
    seed.required = ["TEST", "TESTS", "HURT", "HUGE", "LUNG"];
    seed.bonus = ["HUGS"];
  }
  savePuzzle(seed);
  return getPuzzle(date, mode);
}

/** Fetch official puzzles and store them. Returns {ok, officialToday?, error?}. */
async function fetchAndSaveOfficialPuzzles() {
  const { puzzles, officialToday } = await fetchOfficialPuzzles();
  let updated = 0;
  for (const p of puzzles) {
    insertPuzzle({ ...p, source: "auto-fetch", overwrite: false });
    updated++;
  }
  if (officialToday) setOfficialToday(officialToday);
  for (const mode of ["express", "regular"]) {
    const today = puzzles.find(p => p.date === officialToday && p.mode === mode);
    if (today) {
      fetchedOfficialToday.set(mode, officialToday);
      void prefetchDefinitions([...today.required, ...today.bonus]);
    }
  }
  return { ok: true, count: updated, officialToday };
}

let refreshInFlight;
export function refreshOfficialPuzzles() {
  if (!refreshInFlight) {
    refreshInFlight = fetchAndSaveOfficialPuzzles().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// CLI: `npm run fetch`
if (process.argv[1]?.endsWith("ingest.js")) {
  try {
    const r = await refreshOfficialPuzzles();
    console.log(`saved ${r.count} daily puzzles; official today=${r.officialToday}`);
    for (const d of [r.officialToday, todayDateUTC()]) {
      const p = d && getPuzzle(d);
      if (p) console.log(`${d}: grid=${p.grid.join("")} required=${p.required.length} bonus=${p.bonus.length}`);
    }
  } catch (err) {
    console.log(`auto-fetch failed (${err.message}); keeping existing puzzles`);
    process.exitCode = 1;
  }
}
