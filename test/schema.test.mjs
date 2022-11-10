import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { pointerOf } from '../src/pointer.mjs'
import { createResolver } from '../src/refs.mjs'
import { deepEqual, isDateTime, isMultipleOf, validateExample } from '../src/schema.mjs'

function validate(value, schema, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const root = options.root ?? {}
  const result = validateExample(value, schema, {
    dialect: options.dialect ?? '3.1',
    limits,
    resolver: createResolver(root, limits),
    deadline: options.deadline ?? { exceeded: () => false },
    budget: limits.maxNodes,
    patterns: new Map(),
    exampleParts: ['example'],
    schemaParts: ['schema'],
  })
  return {
    rules: result.problems.map((problem) => problem.ruleId).sort(),
    pointers: result.problems.map((problem) => pointerOf(problem.parts)),
    kinds: result.problems.map((problem) => problem.kind),
    halted: result.halted,
    problems: result.problems,
  }
}

test('a value that satisfies its schema produces nothing at all', () => {
  assert.deepEqual(validate({ a: 'x' }, { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }).rules, [])
})

test('integer is a constraint on a number, not a separate JSON type', () => {
  assert.deepEqual(validate(3, { type: 'integer' }).rules, [])
  assert.deepEqual(validate(3.5, { type: 'integer' }).rules, ['example-type-mismatch'])
  assert.deepEqual(validate(3.5, { type: 'number' }).rules, [])
})

test('a type mismatch stops the other keyword checks rather than piling on', () => {
  assert.deepEqual(validate(7, { type: 'string', minLength: 3, pattern: '^a$' }).rules, ['example-type-mismatch'])
})

test('nullability is spelled differently in each dialect, and each spelling is refused in the other', () => {
  assert.deepEqual(validate(null, { type: 'string', nullable: true }, { dialect: '3.0' }).rules, [])
  assert.deepEqual(validate(null, { type: ['string', 'null'] }).rules, [])
  assert.deepEqual(validate(null, { type: ['string', 'null'] }, { dialect: '3.0' }).rules, ['schema-type-invalid'])
  assert.deepEqual(validate(null, { type: 'string', nullable: true }).rules, ['example-type-mismatch', 'schema-keyword-unsupported'])
})

test('const and $schema belong to 3.1 only', () => {
  assert.deepEqual(validate('b', { const: 'a' }).rules, ['example-const-mismatch'])
  assert.deepEqual(validate('b', { const: 'a' }, { dialect: '3.0' }).rules, ['schema-keyword-unsupported'])
  assert.deepEqual(validate('b', { type: 'string', $schema: 'https://json-schema.org/draft/2020-12/schema' }).rules, [])
  assert.deepEqual(validate('b', { type: 'string', $schema: 'https://json-schema.org/draft/2020-12/schema' }, { dialect: '3.0' }).rules, ['schema-dialect-unsupported'])
  assert.deepEqual(validate('b', { type: 'string', $schema: 'http://json-schema.org/draft-07/schema#' }).rules, ['schema-dialect-unsupported'])
})

test('exclusive bounds are a boolean modifier in 3.0 and a number in 3.1', () => {
  assert.deepEqual(validate(5, { type: 'integer', minimum: 5, exclusiveMinimum: true }, { dialect: '3.0' }).rules, ['example-out-of-range'])
  assert.deepEqual(validate(6, { type: 'integer', minimum: 5, exclusiveMinimum: true }, { dialect: '3.0' }).rules, [])
  assert.deepEqual(validate(5, { type: 'integer', exclusiveMinimum: 5 }).rules, ['example-out-of-range'])
  assert.deepEqual(validate(5, { type: 'integer', exclusiveMinimum: true }).rules, ['schema-malformed'])
  assert.deepEqual(validate(5, { type: 'integer', exclusiveMinimum: 5 }, { dialect: '3.0' }).rules, ['schema-malformed'])
  assert.deepEqual(validate(5, { type: 'integer', exclusiveMinimum: true }, { dialect: '3.0' }).rules, ['schema-malformed'])
})

test('multipleOf does not inherit binary floating point surprises', () => {
  assert.equal(0.3 % 0.1 === 0, false, 'the surprise this exists to avoid')
  assert.equal(isMultipleOf(0.3, 0.1), true)
  assert.equal(isMultipleOf(10, 5), true)
  assert.equal(isMultipleOf(10, 3), false)
  assert.deepEqual(validate(0.3, { type: 'number', multipleOf: 0.1 }).rules, [])
  assert.deepEqual(validate(10, { type: 'integer', multipleOf: 3 }).rules, ['example-out-of-range'])
  assert.deepEqual(validate(10, { type: 'integer', multipleOf: 0 }).rules, ['schema-malformed'])
})

test('the three asserted formats are asserted, and every other format is recorded as not asserted', () => {
  assert.deepEqual(validate('2024-02-29', { type: 'string', format: 'date' }).rules, [])
  assert.deepEqual(validate('2023-02-29', { type: 'string', format: 'date' }).rules, ['example-format-invalid'])
  assert.deepEqual(validate('2024-02-30T00:00:00Z', { type: 'string', format: 'date-time' }).rules, ['example-format-invalid'])
  assert.deepEqual(validate('1f3c9b7a-0d42-4e51-9c8b-2a6f5d1e7b04', { type: 'string', format: 'uuid' }).rules, [])
  assert.deepEqual(validate('nope', { type: 'string', format: 'uuid' }).rules, ['example-format-invalid'])

  const annotated = validate('not-an-email', { type: 'string', format: 'email' })
  assert.deepEqual(annotated.rules, ['format-not-asserted'])
  assert.deepEqual(annotated.kinds, ['note'])
})

test('date-time is range checked arithmetically, because Date rolls over instead of refusing', () => {
  assert.equal(new Date('2024-02-30T00:00:00Z').getUTCMonth(), 2, 'Date rolled February 30 into March')
  assert.equal(isDateTime('2024-02-30T00:00:00Z'), false)
  assert.equal(isDateTime('2024-02-29T23:59:60Z'), true)
  assert.equal(isDateTime('2024-02-29T24:00:00Z'), false)
  assert.equal(isDateTime('2024-02-29T00:00:00+05:30'), true)
  assert.equal(isDateTime('2024-02-29T00:00:00+25:00'), false)
  assert.equal(isDateTime('2024-02-29'), false)
})

/**
 * The pattern subset seen from the validator. The analysis itself, and the
 * measured bound on how long a refused pattern may take, are in
 * `test/pattern.test.mjs`.
 */
test('a pattern whose matching cost cannot be bounded is refused rather than run', () => {
  assert.deepEqual(validate('aaa', { type: 'string', pattern: '^(a+)+$' }).rules, ['schema-pattern-unsupported'])
  assert.deepEqual(validate('aaa', { type: 'string', pattern: '^a*a*$' }).rules, ['schema-pattern-unsupported'])
  assert.deepEqual(validate('aaa', { type: 'string', pattern: '[' }).rules, ['schema-pattern-invalid'])
  assert.deepEqual(validate('aaa', { type: 'string', pattern: '^a+$' }).rules, [])
  assert.deepEqual(validate('bbb', { type: 'string', pattern: '^a+$' }).rules, ['example-pattern-mismatch'])
  assert.deepEqual(validate('a', { type: 'string', pattern: 'a'.repeat(201) }, { limits: { maxPatternLength: 200 } }).rules, ['schema-pattern-unsupported'])

  // Refused for this subject, applied to a shorter one: the estimate is a
  // function of both, and neither answer is a pass.
  const long = 'a'.repeat(6000)
  assert.deepEqual(validate(long, { type: 'string', pattern: '[a-z]*1' }).rules, ['schema-pattern-unsupported'])
  assert.deepEqual(validate(long, { type: 'string', pattern: '^[a-z]*1$' }).rules, ['example-pattern-mismatch'])
  assert.deepEqual(validate('abc1', { type: 'string', pattern: '[a-z]*1' }).rules, [])
})

test('an unsupported keyword lets an example fail but never lets it pass', () => {
  const failing = validate({ a: 1 }, { type: 'object', patternProperties: {}, properties: { a: { type: 'string' } } })
  assert.deepEqual(failing.rules, ['example-type-mismatch', 'schema-keyword-unsupported'])
  const passing = validate({ a: 'x' }, { type: 'object', patternProperties: {}, properties: { a: { type: 'string' } } })
  assert.deepEqual(passing.rules, ['schema-keyword-unsupported'])
})

test('a boolean schema is reported rather than silently treated as "anything goes"', () => {
  assert.deepEqual(validate(1, true).rules, ['schema-malformed'])
  assert.deepEqual(validate(1, false).rules, ['schema-malformed'])
  assert.deepEqual(validate(1, 'string').rules, ['schema-malformed'])
})

test('object keywords report the exact member, including one that is not there', () => {
  const missing = validate({ b: 2 }, { type: 'object', required: ['a'], properties: { b: { type: 'number' } }, additionalProperties: false })
  assert.deepEqual(missing.rules, ['example-required-missing'])
  assert.deepEqual(missing.pointers, ['/example/a'])

  const extra = validate({ b: 2, c: 3 }, { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: false })
  assert.deepEqual(extra.pointers, ['/example/c'])

  const typed = validate({ b: 2, c: 'x' }, { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: { type: 'number' } })
  assert.deepEqual(typed.rules, ['example-type-mismatch'])
  assert.deepEqual(typed.pointers, ['/example/c'])
})

test('array keywords report the index that offends', () => {
  const duplicate = validate(['a', 'b', 'a'], { type: 'array', uniqueItems: true, items: { type: 'string' } })
  assert.deepEqual(duplicate.rules, ['example-duplicate-items'])
  assert.deepEqual(duplicate.pointers, ['/example/2'])

  const wrong = validate(['a', 2], { type: 'array', items: { type: 'string' } })
  assert.deepEqual(wrong.pointers, ['/example/1'])
  assert.deepEqual(validate(['a'], { type: 'array', minItems: 2 }).rules, ['example-length-invalid'])
})

test('deep equality ignores key order and is used by enum, const and uniqueItems', () => {
  const state = { halted: false, budget: 1000, limits: DEFAULT_LIMITS, deadline: { exceeded: () => false } }
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }, state), true)
  assert.equal(deepEqual([1, 2], [2, 1], state), false)
  assert.deepEqual(validate({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }).rules, [])
})

test('a disjunction reports only its aggregate, not the complaints of the branches that lost', () => {
  assert.deepEqual(validate(true, { anyOf: [{ type: 'string' }, { type: 'number' }] }).rules, ['example-any-of-unsatisfied'])
  assert.deepEqual(validate('x', { anyOf: [{ type: 'string' }, { type: 'number' }] }).rules, [])
  assert.deepEqual(validate(true, { oneOf: [{ type: 'string' }, { type: 'number' }] }).rules, ['example-one-of-unsatisfied'])
  assert.deepEqual(validate('ab', { oneOf: [{ type: 'string' }, { minLength: 1 }] }).rules, ['example-one-of-ambiguous'])
  assert.deepEqual(validate(1, { allOf: [{ type: 'integer' }, { type: 'string' }] }).rules, ['example-type-mismatch'])
  assert.deepEqual(validate(1, { anyOf: [] }).rules, ['schema-malformed'])
})

test('a branch that could not be evaluated suppresses the accusation the aggregate would make', () => {
  const result = validate(true, { anyOf: [{ type: 'string' }, { type: 'number', not: {} }] })
  assert.deepEqual(result.rules, ['schema-keyword-unsupported'])
  assert.equal(result.rules.includes('example-any-of-unsatisfied'), false)
})

test('a recursive schema terminates, because every hop consumes a level of the example', () => {
  const root = {
    components: {
      schemas: {
        Node: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } },
        },
      },
    },
  }
  const good = validate({ name: 'a', child: { name: 'b' } }, { $ref: '#/components/schemas/Node' }, { root })
  assert.deepEqual(good.rules, [])

  const bad = validate({ name: 'a', child: { name: 7 } }, { $ref: '#/components/schemas/Node' }, { root })
  assert.deepEqual(bad.rules, ['example-type-mismatch'])
  assert.deepEqual(bad.pointers, ['/example/child/name'])
})

test('a cycle that travels through a keyword is caught even though the resolver never sees it', () => {
  const root = {
    components: {
      schemas: {
        A: { allOf: [{ $ref: '#/components/schemas/B' }] },
        B: { allOf: [{ $ref: '#/components/schemas/A' }] },
      },
    },
  }
  const result = validate({}, { $ref: '#/components/schemas/A' }, { root })
  assert.deepEqual(result.rules, ['ref-cycle'])
})

test('a spent budget halts the run and withdraws the accusations it had reached', () => {
  const result = validate({ a: 1, b: 2, c: 3 }, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } }, { limits: { maxNodes: 2 } })
  assert.equal(result.halted, true)
  assert.deepEqual(result.rules, ['node-budget-exceeded'])
})

test('a spent time budget is reported the same way, through the injected clock', () => {
  let now = 0
  const result = validate({ a: 1 }, { type: 'object', properties: { a: { type: 'string' } } }, {
    deadline: { exceeded: () => { now += 1; return now > 1 } },
  })
  assert.equal(result.halted, true)
  assert.deepEqual(result.rules, ['time-budget-exceeded'])
})

test('schema evaluation depth is bounded independently of the example depth', () => {
  const schema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } }
  assert.deepEqual(validate({ a: { b: 1 } }, schema, { limits: { maxEvalDepth: 1 } }).rules, ['schema-too-deep'])
  assert.deepEqual(validate({ a: { b: 1 } }, schema, { limits: { maxEvalDepth: 2 } }).rules, ['example-type-mismatch'])
})
