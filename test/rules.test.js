import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Race rules contract (mirrors server state machine):
// - countdown needs ALL joined players ready, min 2
// - late join during countdown drops back to lobby
// - finish = 100% of required words, bonus excluded
// - no timeout: race stays live until everyone finished/gave up
function allReady(players) {
  return players.length >= 2 && players.every((p) => p.ready);
}
function isFinished(foundRequired, requiredTotal) {
  return foundRequired >= requiredTotal;
}

describe("race rules", () => {
  it("waits for all: one not-ready blocks countdown", () => {
    assert.equal(allReady([{ ready: 1 }, { ready: 0 }]), false);
    assert.equal(allReady([{ ready: 1 }, { ready: 1 }]), true);
  });
  it("needs at least 2 players", () => {
    assert.equal(allReady([{ ready: 1 }]), false);
  });
  it("bonus words do not count toward 100%", () => {
    assert.equal(isFinished(9, 10), false);
    assert.equal(isFinished(10, 10), true);
  });
});
