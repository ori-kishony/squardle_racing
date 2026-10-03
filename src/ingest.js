// Daily puzzle ingest: best-effort auto-fetch of the official Squaredle
// Express puzzle + manual fallback. The official site has no public API,
// so this parser is intentionally fragile; server keeps last-known puzzle
// and the admin UI allows manual paste when the scrape breaks.
import { db } from "./db.js";

export function todayDateUTC() {
  return new Date().toISOString().slice(0, 10);
}

function extractGridAndWords(html) {
  // Look for embedded JSON blobs: 9-letter grids and word arrays.
  // Heuristic 1: `"grid":"abcdefghi"` or `"letters":[...]`
  const grids = [];
  for (const m of html.matchAll(/"grid"\s*:\s*"([a-zA-Z]{9})"/g))
    grids.push(m[1].toUpperCase());
  for (const m of html.matchAll(/"letters"\s*:\s*\[([^\]]{10,80})\]/g)) {
    const letters = [...m[1].matchAll(/"([a-zA-Z])"/g)].map((x) => x[1]);
    if (letters.length === 9) grids.push(letters.join("").toUpperCase());
  }
  // Heuristic 2: word lists `"words":[...]` / `"answers":[...]`
  const lists = [];
  for (const key of ["words", "answers", "required", "solutions"]) {
    for (const m of html.matchAll(
      new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]{5,2000})\\]`, "g")
    )) {
      const words = [...m[1].matchAll(/"([a-zA-Z]{3,9})"/g)].map((x) =>
        x[1].toUpperCase()
      );
      if (words.length >= 5) lists.push(words);
    }
  }
  return { grids, lists };
}

export async function fetchOfficialExpress() {
  const urls = ["https://squaredle.app/xp", "https://squaredle.app/"];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "squardle-racing (friends-group, 1 req/day)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      // Follow bundled JS: fetch script tags and scan them too.
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
        (m) => new URL(m[1], url).toString()
      );
      let combined = html;
      for (const src of scripts.slice(0, 12)) {
        try {
          const r = await fetch(src, {
            headers: { "User-Agent": "squardle-racing" },
          });
          if (r.ok) combined += "\n" + (await r.text());
        } catch {
          /* ignore individual script failures */
        }
      }
      const { grids, lists } = extractGridAndWords(combined);
      if (grids.length && lists.length) {
        // Pick the most frequent 9-letter grid and the longest word list.
        const grid =
          grids.sort(
            (a, b) =>
              grids.filter((g) => g === b).length -
              grids.filter((g) => g === a).length
          )[0];
        const required = lists.sort((a, b) => b.length - a.length)[0];
        return { ok: true, grid: grid.split(""), required, bonus: [] };
      }
      lastErr = "parsed 0 grids/lists from official HTML+JS";
    } catch (err) {
      lastErr = String(err?.message || err);
    }
  }
  return { ok: false, reason: lastErr || "unknown fetch error" };
}

export function savePuzzle({ date, grid, required, bonus = [], source }) {
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
  // Seed sample so the app is playable before the first successful scrape.
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

// CLI: `npm run fetch [-- YYYY-MM-DD]`
if (process.argv[1]?.endsWith("ingest.js")) {
  const date = process.argv[2] || todayDateUTC();
  const r = await fetchOfficialExpress();
  if (r.ok) {
    savePuzzle({ date, ...r, source: "auto-fetch" });
    console.log(`saved ${date}: grid=${r.grid.join("")} words=${r.required.length}`);
  } else {
    console.log(`auto-fetch failed (${r.reason}); keeping existing/manual puzzle`);
    ensurePuzzleFor(date);
    console.log(`ensured puzzle for ${date} (source=${getPuzzle(date).source})`);
  }
}
