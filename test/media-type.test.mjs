import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeOpenApi, classifyMediaType } from '../src/index.mjs'

function analyze(content) {
  return analyzeOpenApi({
    bytes: new TextEncoder().encode(JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Orders', version: '1' },
      paths: { '/orders': { post: { requestBody: { content } }, responses: {} } },
    })),
    source: 'api.json',
  }).report
}

test('a media type is classified by its essence, with parameters read rather than ignored', () => {
  assert.equal(classifyMediaType('application/json').kind, 'json')
  assert.equal(classifyMediaType('Application/JSON').kind, 'json')
  assert.equal(classifyMediaType('application/vnd.orders.v2+json').kind, 'json')
  assert.equal(classifyMediaType('application/problem+json; charset=utf-8').kind, 'json')
  assert.equal(classifyMediaType('text/plain').kind, 'text')
  assert.equal(classifyMediaType('text/html').kind, 'unsupported')
  assert.equal(classifyMediaType('application/xml').kind, 'unsupported')
  assert.equal(classifyMediaType('multipart/form-data').kind, 'unsupported')
  assert.equal(classifyMediaType('application/x-www-form-urlencoded').kind, 'unsupported')
  assert.equal(classifyMediaType('*/*').kind, 'unsupported')
  assert.equal(classifyMediaType('json').kind, 'malformed')
  assert.equal(classifyMediaType('application/').kind, 'malformed')
  assert.equal(classifyMediaType('application/js on').kind, 'malformed')
  assert.equal(classifyMediaType('application/json; charset=iso-8859-1').kind, 'charset')
})

/**
 * The acceptance case: one operation, two media types, two schemas.
 *
 * The same value is valid under one and invalid under the other, so a tool that
 * picked "the schema" rather than "the schema for this media type" would get
 * exactly one of these two findings wrong. Both pointers are asserted, because
 * a right answer at the wrong position is still the wrong answer.
 */
test('each example is checked against the schema declared for its own media type', () => {
  const report = analyze({
    'application/json': {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      example: { id: 4 },
    },
    'text/plain': {
      schema: { type: 'string', maxLength: 4 },
      example: 'id=40000',
    },
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(report.findings.map((finding) => [finding.ruleId, finding.location.pointer]), [
    ['example-length-invalid', '/paths/~1orders/post/requestBody/content/text~1plain/example'],
  ])
})

test('the same value swaps which media type it offends when the two schemas swap', () => {
  const report = analyze({
    'application/json': {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      example: { id: 'four' },
    },
    'text/plain': {
      schema: { type: 'string', maxLength: 40 },
      example: 'id=4',
    },
  })
  assert.deepEqual(report.findings.map((finding) => [finding.ruleId, finding.location.pointer]), [
    ['example-type-mismatch', '/paths/~1orders/post/requestBody/content/application~1json/example/id'],
  ])
})

test('an example under a text media type must be a string, whatever its schema says', () => {
  const report = analyze({
    'application/json': { schema: { type: 'string' }, example: 'id=4' },
    'text/plain': { schema: { type: 'string' }, example: { id: 4 } },
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['example-not-text'])
  assert.equal(report.findings[0].evidence, 'object')
  // The same value under the JSON media type is checked and accepted; only the
  // text one is refused, and only the checked one counts.
  assert.equal(report.summary.examples, 2)
  assert.equal(report.summary.checked, 1)
})

test('an unmodelled media type is reported by name and its examples are left unchecked', () => {
  const report = analyze({ 'application/xml': { schema: { type: 'string' }, example: '<a/>' } })
  assert.equal(report.status, 'incomplete')
  // "/paths" is a prefix of the media type's pointer, so it sorts first.
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-examples-declared', 'media-type-unsupported'])
  assert.equal(report.findings[1].evidence, 'application/xml')
  assert.equal(report.summary.checked, 0)
})

test('a vendor JSON suffix is treated as JSON, so its examples really are checked', () => {
  const report = analyze({
    'application/vnd.orders.v2+json': { schema: { type: 'integer' }, example: 'four' },
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['example-type-mismatch'])
  assert.equal(report.summary.checked, 1)
})
