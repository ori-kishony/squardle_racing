import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../src/words.js';
process.env.DB_PATH = ':memory:';
const { decoderFromBundle, refreshOfficialPuzzles, currentPuzzleDate, getPuzzle, parsePuzzleConfig, ensurePuzzleFor } = await import('../src/ingest.js');
const { puzzleDateAt } = await import('../src/calendar.js');
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('puzzle decoder survives renamed Closure variables', () => {
  for (const index of ['p', 'n', 'renamedIndex']) {
    const bundle = `f=function(r){var ${index}=e.indexOf(r);return-1==${index}?r:e[(${index}-12+e.length)%e.length]}`;
    assert.equal(decoderFromBundle(bundle).rot,12);
  }
  assert.throws(() => decoderFromBundle('unexpected bundle'), /decoder function/);
});

test('fresh published date takes precedence, stale fetch cannot freeze the calendar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squaredle-ingest-'));
  process.env.OFFICIAL_TODAY_PATH = join(dir, 'official.json');
  const originalFetch = globalThis.fetch;
  const calendarDate = puzzleDateAt();
  let publishedDate = new Date(Date.parse(`${calendarDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const encode = words => [...Buffer.from(words).toString('base64')].map(c => {
    const i = alpha.indexOf(c);
    return i < 0 ? c : alpha[(i + 12) % alpha.length];
  }).join('');
  globalThis.fetch = async url => {
    let body;
    if (url.includes('today-puzzle-config')) {
      const date = publishedDate.replaceAll('-', '/');
      body = `const gPuzzleConfig = ${JSON.stringify({puzzles: {[`${date}-xp`]: {
        board: ['tet', 'ahr', 'lug'], wordScores: encode('the,hug,rug,lug,hurt'), optionalWordScores: '',
      }}})};\nconst gTodayDateStr = '${date}';`;
    } else if (url.includes('closure-')) {
      body = `var e="${alpha}";f=function(r){var n=e.indexOf(r);return-1==n?r:e[(n-12+e.length)%e.length]}`;
    } else {
      body = '<script src="/api/today-puzzle-config.js"></script><script src="closure-test.js"></script>';
    }
    return new Response(body);
  };
  try {
    await refreshOfficialPuzzles();
    assert.equal(currentPuzzleDate(), publishedDate);
    assert.equal(currentPuzzleDate("regular"), calendarDate);
    assert.equal(getPuzzle(currentPuzzleDate()).source, 'auto-fetch');
    publishedDate = '2020-01-01';
    await refreshOfficialPuzzles();
    assert.equal(currentPuzzleDate(), calendarDate);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OFFICIAL_TODAY_PATH;
    rmSync(dir, {recursive: true, force: true});
  }
});


test('ingest separates both official variants, preserving holes and long Regular words', () => {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const encode = words => [...Buffer.from(words).toString('base64')].map(c => {
    const i = alpha.indexOf(c);
    return i < 0 ? c : alpha[(i+12)%alpha.length];
  }).join('');
  const puzzles = {
    '2026/11/11-xp': {board:['tet','ahr','lug'],wordScores:encode('the,hug,rug,lug,hurt')},
    '2026/11/11': {board:['abcd','hgfe','ijkl','pon '],wordScores:encode('abcd,abcde,abcdef,abcdefg,abcdefghijkl'),optionalWordScores:encode('dcba')},
    '2026/11/11-special': {board:['abc','def','ghi'],wordScores:encode('abc,def,ghi,abcd,abce')},
  };
  const parse = () => parsePuzzleConfig(`const gPuzzleConfig = ${JSON.stringify({puzzles})};\nconst gTodayDateStr = '2026/11/11';`,[alpha],12);
  const result = parse();
  assert.equal(result.puzzles.length,2);
  assert.deepEqual(result.puzzles.map(p=>p.mode),['express','regular']);
  assert.equal(result.puzzles[1].grid.length,16);
  assert.equal(result.puzzles[1].grid[15],'');
  assert.equal(result.puzzles[1].required[4],'ABCDEFGHIJKL');
  assert.deepEqual(result.puzzles[1].bonus,['DCBA']);
  puzzles['2026/11/11'].wordScores = 'broken';
  assert.equal(parse().puzzles[0].mode,'express');
  assert.equal(parse().puzzles.length,1);
});

test('offline seed words have paths in each mode', () => {
  const previous = process.env.NO_FETCH;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {status:404});
  process.env.NO_FETCH = '1';
  try {
    for (const mode of ['express','regular']) {
      const p = ensurePuzzleFor('2000-01-01',mode);
      for (const word of [...p.required,...p.bonus]) assert(findPath(p.grid,word),`${mode}: ${word}`);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.NO_FETCH; else process.env.NO_FETCH = previous;
  }
});
