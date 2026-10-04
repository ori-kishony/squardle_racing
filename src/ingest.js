// Daily puzzle ingest: fetches the official Squaredle Express puzzle.
//
// The official site has no public API, but it publishes its puzzle data in
// `/api/today-puzzle-config.js` (referenced from `/?level=xp`). Word lists
// are obfuscated with a char-substitution + base64; the substitution alphabet
// and rotation are extracted live from the bundled closure-*.js so this
// keeps working across redeploys. `gTodayDateStr` from the config is the
// authority for "which puzzle is today's".
import { db } from "./db.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPath } from "./words.js";
import { prefetchDefinitions } from "./definitions.js";

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

/** Which puzzle date should new races use? Official calendar wins when known. */
export function currentPuzzleDate() {
  const official = getOfficialToday();
  if (official && getPuzzle(official)) return official;
  return todayDateUTC();
}

async function get(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function extractDecoderClosures(html) {
  const m = html.match(/<script[^>]+src="([^"]*closure-[^"]*\.js)"/);
  if (!m) throw new Error("closure bundle not found in HTML");
  const js = await get(new URL(m[1], "https://squaredle.app/").toString());
  // Substitution: g=function(r){var p=e.indexOf(r);return-1==p?r:e[(p-N+e.length)%e.length]}
  const fn = js.match(
    /(\w+)=function\(\w+\)\{var \w+=(\w+)\.indexOf\(\w+\);return-1==\w+\?\w+:\2\[\(p-(\d+)\+\2\.length\)%\2\.length\]\}/
  );
  // Fallback to the looser shape if closure renames locals.
  const loose =
    fn ||
    js.match(/indexOf\(\w+\);return-1==\w+\?\w+:\w+\[\(p-(\d+)\+\w+\.length\)%\w+\.length\]\}/);
  if (!loose) throw new Error("decoder function not found in bundle");
  const rot = parseInt(loose[3] ?? loose[1], 10);
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

function parsePuzzleConfig(scriptText, alphas, rot) {
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
    if (!key.endsWith("-xp") || !Array.isArray(e.board)) continue;
    const date = key.slice(0, 10).replaceAll("/", "-");
    const grid = e.board.join("").toUpperCase().split("");
    if (grid.length !== 9) continue;
    let required = null, bonus = [];
    for (const alpha of alphas) {
      try {
        const req = tryDecode(e.wordScores || "", alpha, rot).split(",").filter(Boolean);
        const bon = tryDecode(e.optionalWordScores || "", alpha, rot).split(",").filter(Boolean);
        // Sanity: words must be lowercase alpha, 3-9 chars.
        if (req.length >= 5 && req.every((w) => /^[a-z]{3,9}$/.test(w))) {
          required = req.map((w) => w.toUpperCase());
          bonus = bon.filter((w) => /^[a-z]{3,9}$/.test(w)).map((w) => w.toUpperCase());
          break;
        }
      } catch { /* try next alphabet */ }
    }
    if (!required) throw new Error(`could not decode words for ${key}`);
    out.push({ date, grid, required, bonus });
  }
  return { puzzles: out, officialToday };
}

export async function fetchOfficialExpress() {
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

export function savePuzzle({ date, grid, required, bonus = [], source }) {
  const problems = required.filter(
    (w) => !findPath(grid.map((c) => String(c).toUpperCase()), w)
  );
  if (problems.length)
    console.warn(`puzzle ${date}: ${problems.length} required words have no grid path: ${problems.join(",")}`);
  insertPuzzle({ date, grid, required, bonus, source, overwrite: true });
  void prefetchDefinitions([...required, ...bonus]);
}

function insertPuzzle({ date, grid, required, bonus = [], source, overwrite }) {
  if (!overwrite) {
    const existing = getPuzzle(date);
    if (existing) {
      // Never clobber a real/manual puzzle underneath a room that may be racing it.
      if (existing.source !== "seed-sample") return "kept";
      // A seed row may only be upgraded while its races haven't started
      // (lobby = grid never revealed, no finds possible yet).
      const started = db
        .prepare(
          `SELECT 1 FROM races WHERE puzzle_date = ? AND status != 'lobby' LIMIT 1`
        )
        .get(date);
      if (started) return "kept";
    }
  }
  db.prepare(
    `INSERT INTO puzzles (date, grid, required, bonus, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET grid=excluded.grid, required=excluded.required,
       bonus=excluded.bonus, source=excluded.source`
  ).run(
    date,
    JSON.stringify(grid.map((c) => String(c).toUpperCase())),
    JSON.stringify(required.map((w) => w.toUpperCase())),
    JSON.stringify(bonus.map((w) => w.toUpperCase())),
    source
  );
}

export function getPuzzle(date) {
  const row = db.prepare("SELECT * FROM puzzles WHERE date = ?").get(date);
  if (!row) return null;
  return {
    date: row.date,
    grid: JSON.parse(row.grid),
    required: JSON.parse(row.required),
    bonus: JSON.parse(row.bonus),
    source: row.source,
  };
}

export function ensurePuzzleFor(date) {
  if (getPuzzle(date)) return getPuzzle(date);
  // Offline fallback so the app is playable before the first successful scrape.
  const seed = {
    date,
    grid: ["T", "E", "T", "A", "H", "R", "L", "U", "G"],
    required: ["THE", "HUG", "RUG", "LUG", "HURT", "EAT", "TEA", "HAT", "LAT", "GUR"],
    bonus: ["RUL", "LUR", "RUA", "UGH"],
    source: "seed-sample",
  };
  savePuzzle(seed);
  return getPuzzle(date);
}

/** Fetch official puzzles and store them. Returns {ok, officialToday?, error?}. */
export async function refreshOfficialPuzzles() {
  const { puzzles, officialToday } = await fetchOfficialExpress();
  let updated = 0;
  for (const p of puzzles) {
    insertPuzzle({ ...p, source: "auto-fetch", overwrite: false });
    updated++;
  }
  if (officialToday) setOfficialToday(officialToday);
  const today = puzzles.find((p) => p.date === officialToday);
  if (today) void prefetchDefinitions([...today.required, ...today.bonus]);
  return { ok: true, count: updated, officialToday };
}

// CLI: `npm run fetch`
if (process.argv[1]?.endsWith("ingest.js")) {
  try {
    const r = await refreshOfficialPuzzles();
    console.log(`saved ${r.count} express puzzles; official today=${r.officialToday}`);
    for (const d of [r.officialToday, todayDateUTC()]) {
      const p = d && getPuzzle(d);
      if (p) console.log(`${d}: grid=${p.grid.join("")} required=${p.required.length} bonus=${p.bonus.length}`);
    }
  } catch (err) {
    console.log(`auto-fetch failed (${err.message}); keeping existing puzzles`);
    ensurePuzzleFor(currentPuzzleDate());
  }
}
