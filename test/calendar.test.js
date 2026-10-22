import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puzzleDateAt, puzzleEndsAt, nextPuzzleRefreshAt } from '../src/calendar.js';

test('daily rollover is 3am Pacific, not UTC or local midnight', () => {
  assert.equal(puzzleDateAt(Date.parse('2026-10-11T09:59:59.999Z')), '2026-10-10');
  assert.equal(puzzleDateAt(Date.parse('2026-10-11T10:00:00Z')), '2026-10-11');
  assert.equal(puzzleEndsAt('2026-10-10'), Date.parse('2026-10-11T10:00:00Z'));
});
test('refreshes align to 20 seconds after the hour and the exact daily rollover', () => {
  for (const [time, expected] of [
    ['2026-10-13T08:42:00Z', '2026-10-13T09:00:20Z'],
    ['2026-10-13T09:00:19.999Z', '2026-10-13T09:00:20Z'],
    ['2026-10-13T09:00:20Z', '2026-10-13T10:00:00Z'],
    ['2026-10-13T10:00:00Z', '2026-10-13T10:00:20Z'],
    ['2026-10-13T10:00:20Z', '2026-10-13T11:00:20Z'],
    ['2026-03-08T09:50:00Z', '2026-03-08T10:00:00Z'],
    ['2026-11-01T10:50:00Z', '2026-11-01T11:00:00Z'],
  ]) assert.equal(nextPuzzleRefreshAt(Date.parse(time)), Date.parse(expected), time);
});
test('expiry handles both daylight saving transitions', () => {
  for (const [date, expected] of [['2026-03-07', '2026-03-08T10:00:00Z'], ['2026-10-31', '2026-11-01T11:00:00Z']]) {
    const end = puzzleEndsAt(date);
    assert.equal(end, Date.parse(expected));
    assert.equal(puzzleDateAt(end - 1), date);
    assert.notEqual(puzzleDateAt(end), date);
  }
});
