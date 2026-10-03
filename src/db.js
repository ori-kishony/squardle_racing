import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath =
  process.env.DB_PATH || join(root, "data", "squardle_racing.sqlite3");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS puzzles (
  date TEXT PRIMARY KEY,
  grid TEXT NOT NULL,
  required TEXT NOT NULL,
  bonus TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code),
  nickname TEXT NOT NULL,
  acronym TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code),
  puzzle_date TEXT NOT NULL REFERENCES puzzles(date),
  status TEXT NOT NULL DEFAULT 'lobby',
  starts_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS race_players (
  race_id TEXT NOT NULL REFERENCES races(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  ready INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  gave_up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, player_id)
);
CREATE TABLE IF NOT EXISTS finds (
  race_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  word TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  is_bonus INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, player_id, word)
);
CREATE TABLE IF NOT EXISTS king_history (
  room_code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  won_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, race_id)
);
`);

// Accuracy tracking: wrong guesses (only "not-in-list" hurts, like the
// original — too-short / already-found / bonus never count against you).
// Older DBs need the column added.
try {
  db.exec("ALTER TABLE race_players ADD COLUMN invalid_guesses INTEGER NOT NULL DEFAULT 0");
} catch {
  /* column already exists */
}

export function acronymFor(nickname) {
  const parts = nickname.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.map((p) => p[0]).join("").toUpperCase();
  return (letters || nickname.trim()[0] || "?").slice(0, 3).toUpperCase();
}
