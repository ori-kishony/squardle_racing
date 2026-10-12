import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puzzleDateAt, puzzleEndsAt } from '../src/calendar.js';

test('daily rollover is 3am Pacific, not UTC or local midnight', () => {
  assert.equal(puzzleDateAt(Date.parse('2026-10-11T09:59:59.999Z')), '2026-10-10');
  assert.equal(puzzleDateAt(Date.parse('2026-10-11T10:00:00Z')), '2026-10-11');
  assert.equal(puzzleEndsAt('2026-10-10'), Date.parse('2026-10-11T10:00:00Z'));
});
test('expiry handles both daylight saving transitions', () => {
  for (const [date, expected] of [['2026-03-07', '2026-03-08T10:00:00Z'], ['2026-10-31', '2026-11-01T11:00:00Z']]) {
    const end = puzzleEndsAt(date);
    assert.equal(end, Date.parse(expected));
    assert.equal(puzzleDateAt(end - 1), date);
    assert.notEqual(puzzleDateAt(end), date);
  }
});
