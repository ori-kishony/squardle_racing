// Shared grid path logic: 3x3 Squaredle Express rules.
// - min length 3, adjacent incl. diagonals, no cell reuse.

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

const NEIGHBORS = (() => {
  const n = [];
  for (let i = 0; i < 9; i++) {
    const r = Math.floor(i / 3), c = i % 3;
    const list = [];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;
      list.push(nr * 3 + nc);
    }
    n.push(list);
  }
  return n;
})();

/**
 * Exhaustive cell usage for one word: which cells can start a valid path,
 * and which cells appear in ANY valid path. Counts each word once per cell.
 * Returns { starts: Set<number>, uses: Set<number> } (empty sets = no path).
 */
export function wordCellUsage(grid, word) {
  const w = String(word || "").toUpperCase();
  const g = grid.map((c) => String(c).toUpperCase());
  const starts = new Set();
  const uses = new Set();
  if (w.length < 3 || w.length > 9) return { starts, uses };
  // Try every start cell; DFS collects all paths (grid is tiny).
  function dfs(pos, idx, used, path) {
    if (g[pos] !== w[idx]) return;
    used.add(pos);
    path.push(pos);
    if (idx === w.length - 1) {
      starts.add(path[0]);
      for (const c of path) uses.add(c);
    } else {
      for (const ni of NEIGHBORS[pos]) {
        if (used.has(ni)) continue;
        dfs(ni, idx + 1, used, path);
      }
    }
    used.delete(pos);
    path.pop();
  }
  for (let i = 0; i < 9; i++) {
    if (g[i] !== w[0]) continue;
    dfs(i, 0, new Set(), []);
  }
  return { starts, uses };
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

/** Find one valid path (array of cell indexes 0-8) spelling `word` on `grid`, or null. */
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
  const path = findPath(grid, w);
  if (!path) return { ok: false, reason: "no-path", isBonus };
  return { ok: true, word: w, isBonus, path };
}
