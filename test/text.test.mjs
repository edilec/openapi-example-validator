import assert from 'node:assert/strict'
import test from 'node:test'

import { EXCERPT_LIMIT, byCodeUnit, decodeUtf8, renderValue, sanitize } from '../src/text.mjs'

test('byCodeUnit orders by code unit, which is not what a collator would do', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('a', 'a'), 0)
})

test('decoding is strict: undecodable bytes are refused, not repaired', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])).ok, false)
})

test('a literal replacement character decodes successfully and is not mistaken for a fault', () => {
  const bytes = new TextEncoder().encode('{"a":"�"}')
  const decoded = decodeUtf8(bytes)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text.includes('�'), true)
})

test('every class of forging character is removed, not only C0', () => {
  const forging = [
    0x0000, 0x0007, 0x000A, 0x001F, 0x007F,
    0x0085, 0x009B, 0x009F,
    0x2028, 0x2029,
    0x200E, 0x200F, 0x202A, 0x202E, 0x2066, 0x2069,
  ]
  for (const codePoint of forging) {
    const character = String.fromCodePoint(codePoint)
    const cleaned = sanitize(`a${character}b`)
    assert.equal(cleaned.includes(character), false, `U+${codePoint.toString(16)} survived`)
    assert.equal(cleaned, 'a b')
  }
})

test('sanitising bounds the result and marks where it stopped', () => {
  const long = 'x'.repeat(EXCERPT_LIMIT + 50)
  const cleaned = sanitize(long)
  assert.equal(cleaned.length, EXCERPT_LIMIT + 3)
  assert.equal(cleaned.endsWith('...'), true)
  assert.throws(() => sanitize('x', 0), TypeError)
})

test('rendering a value escapes what JSON escapes and strips what it does not', () => {
  assert.equal(renderValue({ a: `b${String.fromCodePoint(0x0a)}c` }), '{"a":"b\\nc"}')
  assert.equal(renderValue(`x${String.fromCodePoint(0x2028)}y`), '"x y"')
  assert.equal(renderValue(undefined), 'undefined')
})
