import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPgError } from '../src/errors.js';

/*
 * Under sustained system-wide overload (every pooled connection busy, not just one contended
 * row), node-postgres' own pool-queue timeout has no SQLSTATE .code — it's a plain client-side
 * Error. Unmapped, it would fall through app.js's error handler as an unrecognised error and
 * surface as a bare 500 "internal_error" instead of the same clean 503 "busy, retry" that
 * row-lock contention already gets. These pin the exact shapes observed from real `pg` behaviour
 * (see the reproduction that generated them) so a future refactor can't silently drop this path.
 */

test('fromPgError: a real pool-timeout error (no .code) maps to contention_timeout', () => {
  const err = new Error('timeout exceeded when trying to connect'); // observed shape: code undefined
  const e = fromPgError(err);
  assert.equal(e.code, 'contention_timeout');
  assert.equal(e.status, 503);
});

test('fromPgError: a database-unreachable error maps to contention_timeout', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']) {
    const err = Object.assign(new Error('connect failed'), { code });
    const e = fromPgError(err);
    assert.equal(e.code, 'contention_timeout', `expected ${code} to map to contention_timeout`);
    assert.equal(e.status, 503);
  }
});

test('fromPgError: existing Postgres SQLSTATE mappings are unaffected', () => {
  assert.equal(fromPgError(Object.assign(new Error(), { code: '55P03' })).code, 'contention_timeout');
  assert.equal(fromPgError(Object.assign(new Error(), { code: '40P01' })).code, 'contention_timeout');
  assert.equal(fromPgError(Object.assign(new Error(), { code: '40001' })).code, 'contention_timeout');
  assert.equal(fromPgError(Object.assign(new Error(), { code: '23503', constraint: 'x' })).code, 'invalid_id');
  assert.equal(fromPgError(Object.assign(new Error(), { code: '23514', constraint: 'x' })).code, 'sold_out');
});

test('fromPgError: an unrelated error is returned unchanged, not swallowed as busy', () => {
  const err = new TypeError('something else entirely');
  assert.equal(fromPgError(err), err);
});
