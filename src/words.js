// Shared grid path logic: 3x3 Squaredle Express rules.
// - min length 3, adjacent incl. diagonals, no cell reuse.

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

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
