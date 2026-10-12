import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { decoderFromBundle, refreshOfficialPuzzles, currentPuzzleDate, getPuzzle } = await import('../src/ingest.js');
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
