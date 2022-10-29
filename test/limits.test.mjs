import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, analyzeOpenApi } from '../src/index.mjs'

/**
 * Every documented limit, driven from both sides of its bound.
 *
 * A limit tested only from the far side proves that something refuses a huge
 * input; it does not prove the bound is where the documentation says it is, and
 * an off-by-one there is the difference between a limit and a decoration. So
 * each case below runs the value that must be accepted and the value one step
 * past it that must be refused by name.
 */

const encode = (document) => new TextEncoder().encode(JSON.stringify(document))

function run(document, limits, clock) {
  return analyzeOpenApi({ bytes: encode(document), source: 'api.json', limits, clock }).report
}

const rules = (report) => report.findings.map((finding) => finding.ruleId)

function description(paths, extra = {}) {
  return { openapi: '3.1.0', info: { title: 'Orders', version: '1' }, paths, ...extra }
}

const one = (media) => description({ '/orders': { get: { responses: { 200: { description: 'ok', content: { 'application/json': media } } } } } })

test('maxBytes is measured on the bytes, at the bound and one byte under it', () => {
  const document = one({ schema: { type: 'integer' }, example: 4 })
  const size = encode(document).length
  assert.equal(rules(run(document, { maxBytes: size })).includes('document-too-large'), false)
  assert.deepEqual(rules(run(document, { maxBytes: size - 1 })), ['document-too-large'])
})

test('maxDepth counts the nesting of the description itself', () => {
  // The scalar leaves count as a level, so this description is three deep:
  // the root, "info", and the strings inside it.
  const document = { openapi: '3.1.0', info: { title: 'o', version: '1' }, paths: {} }
  assert.equal(rules(run(document, { maxDepth: 3 })).includes('document-too-deep'), false)
  assert.deepEqual(rules(run(document, { maxDepth: 2 })), ['document-too-deep'])
})

test('maxNodes has a threshold, and one below it the walk is refused by name', () => {
  const document = one({ schema: { type: 'object', properties: { a: { type: 'string' } } }, example: { a: 'x' } })
  let threshold = null
  for (let budget = 1; budget <= 60 && threshold === null; budget += 1) {
    if (!rules(run(document, { maxNodes: budget })).includes('node-budget-exceeded')) threshold = budget
  }
  assert.notEqual(threshold, null, 'no budget in range completed the walk')
  assert.equal(threshold > 1, true)
  assert.equal(rules(run(document, { maxNodes: threshold })).includes('node-budget-exceeded'), false)
  assert.equal(rules(run(document, { maxNodes: threshold - 1 })).includes('node-budget-exceeded'), true)
})

test('maxOperations counts operations, at the bound and one under it', () => {
  const operation = { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'integer' }, example: 4 } } } } }
  const document = description({ '/orders': { get: operation, post: operation } })
  assert.equal(rules(run(document, { maxOperations: 2 })).includes('too-many-operations'), false)
  assert.deepEqual(rules(run(document, { maxOperations: 1 })), ['too-many-operations'])
})

test('maxExamples counts examples, at the bound and one under it', () => {
  const document = one({ schema: { type: 'integer' }, examples: { a: { value: 1 }, b: { value: 2 } } })
  assert.equal(rules(run(document, { maxExamples: 2 })).includes('too-many-examples'), false)
  assert.deepEqual(rules(run(document, { maxExamples: 1 })), ['too-many-examples'])
})

test('maxExampleBytes measures the serialised example, at the bound and one byte under it', () => {
  const document = one({ schema: { type: 'string' }, example: 'abcd' })
  assert.equal(rules(run(document, { maxExampleBytes: 6 })).includes('example-too-large'), false)
  assert.deepEqual(rules(run(document, { maxExampleBytes: 5 })), ['no-examples-declared', 'example-too-large'])
})

test('maxExampleDepth measures the example, not the description around it', () => {
  const document = one({ schema: { type: 'object' }, example: { a: { b: 1 } } })
  assert.equal(rules(run(document, { maxExampleDepth: 3 })).includes('example-too-deep'), false)
  assert.deepEqual(rules(run(document, { maxExampleDepth: 2 })), ['no-examples-declared', 'example-too-deep'])
})

test('maxRefDepth counts hops in one chain, at the bound and one under it', () => {
  const document = one({ schema: { $ref: '#/components/schemas/Alias' }, example: 4 })
  document.components = { schemas: { Alias: { $ref: '#/components/schemas/Number' }, Number: { type: 'integer' } } }
  assert.equal(rules(run(document, { maxRefDepth: 2 })).includes('ref-depth-exceeded'), false)
  assert.equal(rules(run(document, { maxRefDepth: 1 })).includes('ref-depth-exceeded'), true)
})

test('maxEvalDepth bounds schema evaluation, at the bound and one under it', () => {
  const document = one({
    schema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } },
    example: { a: { b: 'x' } },
  })
  assert.equal(rules(run(document, { maxEvalDepth: 2 })).includes('schema-too-deep'), false)
  assert.equal(rules(run(document, { maxEvalDepth: 1 })).includes('schema-too-deep'), true)
})

test('maxPatternLength bounds the pattern source, at the bound and one character under it', () => {
  const pattern = `^${'a'.repeat(8)}$`
  const document = one({ schema: { type: 'string', pattern }, example: 'a'.repeat(8) })
  assert.equal(rules(run(document, { maxPatternLength: pattern.length })).includes('schema-pattern-unsupported'), false)
  assert.equal(rules(run(document, { maxPatternLength: pattern.length - 1 })).includes('schema-pattern-unsupported'), true)
})

test('maxMillis is measured with the injected clock, at the bound and one below it', () => {
  const document = one({ schema: { type: 'integer' }, example: 4 })
  const clock = () => 0
  assert.equal(rules(run(document, { maxMillis: 1 }, clock)).includes('time-budget-exceeded'), false)
  assert.deepEqual(rules(run(document, { maxMillis: 0 }, clock)), ['time-budget-exceeded'])
})

test('every limit in the default set has a case in this file', () => {
  const covered = new Set(Object.keys(DEFAULT_LIMITS))
  assert.equal(covered.size, 11)
  assert.deepEqual([...covered].sort(), [
    'maxBytes', 'maxDepth', 'maxEvalDepth', 'maxExampleBytes', 'maxExampleDepth', 'maxExamples',
    'maxMillis', 'maxNodes', 'maxOperations', 'maxPatternLength', 'maxRefDepth',
  ])
})
