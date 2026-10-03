import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findPath, validateWord } from "../src/words.js";
import { acronymFor } from "../src/db.js";

const GRID = ["T", "E", "T", "A", "H", "R", "L", "U", "G"];

describe("findPath", () => {
  it("finds THE (T-H diagonal, H-E)", () => {
    assert.deepEqual(findPath(GRID, "THE"), [0, 4, 1]);
  });
  it("rejects words with no path", () => {
    assert.equal(findPath(GRID, "XYZ"), null);
  });
  it("rejects short words", () => {
    assert.equal(findPath(GRID, "AT"), null);
  });
  it("never reuses a cell", () => {
    // TTT would need 3 T cells; grid has T at 0 and 2 only
    assert.equal(findPath(GRID, "TTT"), null);
  });
  it("allows diagonal moves", () => {
    // T(0) -> H(4) diagonal, H(4) -> U(7)
    assert.ok(findPath(GRID, "THU"));
  });
});

describe("validateWord", () => {
  const base = { grid: GRID, required: ["THE", "HUG"], bonus: ["TETH"] };
  it("accepts required word", () => {
    const r = validateWord({ ...base, word: "the", alreadyFound: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.isBonus, false);
  });
  it("flags bonus", () => {
    const r = validateWord({ ...base, word: "teth", alreadyFound: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.isBonus, true);
  });
  it("rejects unknown words", () => {
    assert.equal(validateWord({ ...base, word: "ZZZ", alreadyFound: new Set() }).ok, false);
  });
  it("rejects duplicates", () => {
    const r = validateWord({ ...base, word: "THE", alreadyFound: new Set(["THE"]) });
    assert.equal(r.reason, "already");
  });
});

describe("acronymFor", () => {
  it("uses initials", () => {
    assert.equal(acronymFor("Anna Karen"), "AK");
    assert.equal(acronymFor("bob"), "B");
  });
});
