import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { decoderFromBundle } = await import('../src/ingest.js');
test('puzzle decoder survives renamed Closure variables', () => {
  for (const index of ['p', 'n', 'renamedIndex']) {
    const bundle = `f=function(r){var ${index}=e.indexOf(r);return-1==${index}?r:e[(${index}-12+e.length)%e.length]}`;
    assert.equal(decoderFromBundle(bundle).rot,12);
  }
  assert.throws(() => decoderFromBundle('unexpected bundle'), /decoder function/);
});
