import assert from 'node:assert/strict'
import test from 'node:test'

import {
  escapeSegment,
  measureBytes,
  measureDepth,
  parseFragment,
  pointerOf,
  resolvePointerParts,
  unescapeSegment,
} from '../src/pointer.mjs'

test('a segment is escaped once, in the order RFC 6901 requires', () => {
  assert.equal(escapeSegment('a/b'), 'a~1b')
  assert.equal(escapeSegment('a~b'), 'a~0b')
  assert.equal(escapeSegment('a~/b'), 'a~0~1b')
  assert.equal(unescapeSegment(escapeSegment('m~1/n')), 'm~1/n')
})

test('a media type becomes one escaped segment, not two', () => {
  assert.equal(pointerOf(['content', 'application/json']), '/content/application~1json')
  assert.equal(pointerOf([]), '')
})

test('a fragment parses into segments, and an anchor is refused rather than guessed at', () => {
  assert.deepEqual(parseFragment(''), { ok: true, parts: [] })
  assert.deepEqual(parseFragment('/components/schemas/Pet'), { ok: true, parts: ['components', 'schemas', 'Pet'] })
  assert.deepEqual(parseFragment('/a~1b'), { ok: true, parts: ['a/b'] })
  assert.deepEqual(parseFragment('/a%20b'), { ok: true, parts: ['a b'] })
  assert.equal(parseFragment('Pet').ok, false)
  assert.equal(parseFragment('/a~2b').ok, false)
  assert.equal(parseFragment('/a%zzb').ok, false)
})

test('resolution refuses an index the document never wrote', () => {
  const root = { a: [{ b: 1 }], 'x/y': 2 }
  assert.deepEqual(resolvePointerParts(root, ['a', '0', 'b']), { ok: true, value: 1 })
  assert.deepEqual(resolvePointerParts(root, ['x/y']), { ok: true, value: 2 })
  assert.equal(resolvePointerParts(root, ['a', '01']).ok, false)
  assert.equal(resolvePointerParts(root, ['a', '1']).ok, false)
  assert.equal(resolvePointerParts(root, ['a', 'length']).ok, false)
  assert.equal(resolvePointerParts(root, ['missing']).ok, false)
})

test('resolution does not walk into the prototype chain', () => {
  assert.equal(resolvePointerParts({}, ['constructor']).ok, false)
  assert.equal(resolvePointerParts({}, ['__proto__']).ok, false)
})

test('depth is measured iteratively and stops as soon as the limit is passed', () => {
  assert.deepEqual(measureDepth(1, 10), { depth: 1, exceeded: false })
  assert.deepEqual(measureDepth({ a: { b: 1 } }, 10), { depth: 3, exceeded: false })
  assert.equal(measureDepth({ a: { b: { c: 1 } } }, 2).exceeded, true)

  let deep = 1
  for (let index = 0; index < 20000; index += 1) deep = [deep]
  assert.equal(measureDepth(deep, 40).exceeded, true)
})

test('example size is measured in UTF-8 bytes, not in characters', () => {
  assert.equal(measureBytes('ab'), 4)
  assert.equal(measureBytes('é'), 4)
  assert.equal(measureBytes(undefined), null)
})
