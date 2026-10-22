import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findPath, wordCellUsage, gridHintCounts } from "../src/words.js";

const GRID = ["T", "E", "T", "A", "H", "R", "L", "U", "G"];

describe("deterministic hint paths", () => {
  it("counts a word with multiple starting tiles at only its chosen start", () => {
    // THE can start at either T (0 or 2).
    const { starts, uses } = wordCellUsage(GRID, "the");
    assert.deepEqual([...starts], [0]);
    assert.deepEqual([...uses], [0, 4, 1]);
  });
  it("chooses one path when the same start has multiple continuations", () => {
    const grid = Array(9).fill("A");
    assert.deepEqual(findPath(grid, "AAA"), [0, 1, 2]);
    assert.deepEqual([...wordCellUsage(grid, "AAA").uses], [0, 1, 2]);
    assert.deepEqual(gridHintCounts(grid, ["AAA"]).useCounts, [1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });
  it("aggregates each word's chosen path independently of list order", () => {
    const counts = gridHintCounts(GRID, ["THE", "HUG"]);
    assert.deepEqual(counts.startCounts, [1, 0, 0, 0, 1, 0, 0, 0, 0]);
    assert.deepEqual(counts.useCounts, [1, 1, 0, 0, 2, 0, 0, 1, 1]);
    assert.equal(counts.startCounts.reduce((a, b) => a + b), 2);
    assert.equal(counts.useCounts.reduce((a, b) => a + b), 6);
    const reversed = gridHintCounts(GRID, ["HUG", "THE"]);
    assert.deepEqual(reversed.startCounts, counts.startCounts);
    assert.deepEqual(reversed.useCounts, counts.useCounts);
  });
  it("leaves counts empty for words with no valid path", () => {
    for (const word of ["XYZ", "AT", "TTT", "AAAAAAAAAA", ""]) {
      assert.deepEqual(wordCellUsage(GRID, word), { starts: new Set(), uses: new Set() });
    }
  });
});

