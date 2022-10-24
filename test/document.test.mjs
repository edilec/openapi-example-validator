import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, detectVersion, readDocument, validateLimits } from '../src/document.mjs'

const bytes = (text) => new TextEncoder().encode(text)

test('a caller-supplied limit set is merged, and an unknown key is a configuration error', () => {
  assert.deepEqual(validateLimits(undefined), { ...DEFAULT_LIMITS })
  assert.equal(validateLimits({ maxExamples: 3 }).maxExamples, 3)
  assert.throws(() => validateLimits({ maxExamplesBytes: 3 }), /Unknown limit "maxExamplesBytes"/)
  assert.throws(() => validateLimits({ maxExamples: 0 }), /at least 1/)
  assert.throws(() => validateLimits({ maxExamples: 1.5 }), TypeError)
  assert.throws(() => validateLimits([]), TypeError)
})

test('a zero time budget is allowed, because "no time at all" is a meaningful bound', () => {
  assert.equal(validateLimits({ maxMillis: 0 }).maxMillis, 0)
  assert.throws(() => validateLimits({ maxMillis: -1 }), TypeError)
})

test('size is refused before the bytes are ever held as a string', () => {
  const result = readDocument(bytes('{"openapi":"3.1.0"}'), { ...DEFAULT_LIMITS, maxBytes: 4 })
  assert.equal(result.ok, false)
  assert.equal(result.ruleId, 'document-too-large')
})

test('an encoding fault is reported as an encoding fault, not as a syntax fault', () => {
  const result = readDocument(new Uint8Array([0x7b, 0xff, 0x7d]), DEFAULT_LIMITS)
  assert.equal(result.ok, false)
  assert.equal(result.ruleId, 'document-not-utf8')
})

test('JSON that is not an object is refused as malformed, not accepted as a description', () => {
  assert.equal(readDocument(bytes('[]'), DEFAULT_LIMITS).ruleId, 'document-malformed')
  assert.equal(readDocument(bytes('"x"'), DEFAULT_LIMITS).ruleId, 'document-malformed')
  assert.equal(readDocument(bytes('not json'), DEFAULT_LIMITS).ruleId, 'document-not-json')
})

test('depth is refused before anything walks the document', () => {
  const deep = readDocument(bytes('{"a":{"b":{"c":{"d":1}}}}'), { ...DEFAULT_LIMITS, maxDepth: 3 })
  assert.equal(deep.ruleId, 'document-too-deep')
  assert.equal(readDocument(bytes('{"a":{"b":{"c":1}}}'), { ...DEFAULT_LIMITS, maxDepth: 4 }).ok, true)
})

test('readDocument refuses anything that is not bytes, as configuration rather than as a finding', () => {
  assert.throws(() => readDocument('{}', DEFAULT_LIMITS), TypeError)
})

test('the version decides the dialect, and an unmodelled version is refused', () => {
  assert.deepEqual(detectVersion({ openapi: '3.0.3' }), { ok: true, version: '3.0.3', dialect: '3.0' })
  assert.deepEqual(detectVersion({ openapi: '3.1.0' }), { ok: true, version: '3.1.0', dialect: '3.1' })
  assert.equal(detectVersion({}).ruleId, 'openapi-version-missing')
  assert.equal(detectVersion({ openapi: '2.0' }).ruleId, 'openapi-version-unsupported')
  assert.equal(detectVersion({ openapi: '3.2.0' }).ruleId, 'openapi-version-unsupported')
  assert.equal(detectVersion({ openapi: 3.1 }).ruleId, 'openapi-version-unsupported')
})
