// Shared grid path logic: 3x3 Squaredle Express rules.
// - min length 3, adjacent incl. diagonals, no cell reuse.

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

/**
 * Cell usage on the word's deterministic path, shared with validation.
 * Returns { starts: Set<number>, uses: Set<number> } (empty sets = no path).
 */
export function wordCellUsage(grid, word) {
  const path = findPath(grid, String(word || ""));
  return {
    starts: new Set(path ? [path[0]] : []),
    uses: new Set(path || []),
  };
}

/**
 * Per-cell hint counts over the REQUIRED list (bonus excluded, like original
 * perks which reflect scoring words only).
 * Returns { startCounts, useCounts, wordStarts: Set<number>[], wordUses: Set<number>[] }.
 */
export function gridHintCounts(grid, required) {
  const startCounts = Array(9).fill(0);
  const useCounts = Array(9).fill(0);
  const wordStarts = [];
  const wordUses = [];
  for (const word of required || []) {
    const { starts, uses } = wordCellUsage(grid, word);
    wordStarts.push(starts);
    wordUses.push(uses);
    for (const c of starts) startCounts[c]++;
    for (const c of uses) useCounts[c]++;
  }
  return { startCounts, useCounts, wordStarts, wordUses };
}

/** Unlock thresholds for progressive hints (mirrors original perk pacing). */
export function hintThresholds(requiredTotal) {
  const n = Math.max(1, requiredTotal | 0);
  return {
    // red (bottom-left): # of required words starting here
    startAt: Math.min(n, Math.max(2, Math.ceil(n * 0.25))),
    // gray (bottom-right): # of required words using this square
    useAt: Math.min(n, Math.max(4, Math.ceil(n * 0.5))),
  };
}

/**
 * Find the first valid path spelling `word`, or null.
 * Starts and neighbors are visited in row-major order, so the chosen path is
 * the lexicographically smallest sequence of cell indexes (0-8).
 */
export function findPath(grid, word) {
  const w = word.toUpperCase();
  const g = grid.map((c) => String(c).toUpperCase());
  if (w.length < 3 || w.length > 9) return null;
  const at = (i) => [Math.floor(i / 3), i % 3];

  function dfs(pos, idx, used) {
    if (g[pos] !== w[idx]) return null;
    used = new Set(used).add(pos);
    if (idx === w.length - 1) return [pos];
    const [r, c] = at(pos);
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;
      const ni = nr * 3 + nc;
      if (used.has(ni)) continue;
      const rest = dfs(ni, idx + 1, used);
      if (rest) return [pos, ...rest];
    }
    return null;
  }

  for (let i = 0; i < 9; i++) {
    const p = dfs(i, 0, new Set());
    if (p) return p;
  }
  return null;
}

export function validateWord({ grid, required, bonus, word, alreadyFound }) {
  const w = String(word || "").trim().toUpperCase();
  if (!w) return { ok: false, reason: "empty" };
  if (w.length < 3) return { ok: false, reason: "too-short" };
  const req = new Set(required.map((x) => x.toUpperCase()));
  const bon = new Set((bonus || []).map((x) => x.toUpperCase()));
  const isBonus = bon.has(w) && !req.has(w);
  if (!req.has(w) && !bon.has(w))
    return { ok: false, reason: "not-in-list" };
  if (alreadyFound.has(w))
    return { ok: false, reason: "already", isBonus };
  // The official word list is authoritative. A submitted spelling can be
  // valid even when the server cannot reproduce the specific tile path used.
  const path = findPath(grid, w);
  return { ok: true, word: w, isBonus, path };
}

/** Original-style accuracy: requiredFound / (requiredFound + invalid).
 *  Only "not-in-list" submissions hurt; too-short / already / bonus don't.
 *  Returns 1 when nothing submitted yet. */
export function accuracyFor(requiredFound, invalidGuesses) {
  const denom = (requiredFound | 0) + (invalidGuesses | 0);
  if (!denom) return 1;
  return requiredFound / denom;
}

/** Should this reject reason count against accuracy? (original rule) */
export function hurtsAccuracy(reason) {
  return reason === "not-in-list";
}
