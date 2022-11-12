import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { REPORT_SCHEMA_VERSION, TOOL_ID, analyzeOpenApi, validateOpenApiFile } from '../src/index.mjs'

function analyze(document, options = {}) {
  return analyzeOpenApi({
    bytes: new TextEncoder().encode(JSON.stringify(document)),
    source: 'api.json',
    ...options,
  })
}

const rulesOf = (report) => report.findings.map((finding) => finding.ruleId)

function description(paths, extra = {}) {
  return { openapi: '3.1.0', info: { title: 'Orders', version: '1' }, paths, ...extra }
}

function response(content) {
  return { '/orders': { get: { responses: { 200: { description: 'ok', content } } } } }
}

test('the envelope is the one the report contract describes', () => {
  const { report } = analyze(description(response({ 'application/json': { schema: { type: 'string' }, example: 'ok' } })))
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary, {
    checked: 1, errors: 0, warnings: 0, info: 0, operations: 1, examples: 1, unknown: 0,
  })
  assert.deepEqual(report.findings, [])
})

test('an invalid nested example is given an exact pointer, all the way into the value', () => {
  const { report } = analyze(description({
    '/orders': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Order' },
              examples: {
                basic: {
                  value: { customer: { contacts: [{ email: 'a@b.example' }, { email: 41 }] } },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'made' } },
      },
    },
  }, {
    components: {
      schemas: {
        Order: {
          type: 'object',
          properties: {
            customer: {
              type: 'object',
              properties: {
                contacts: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' } } } },
              },
            },
          },
        },
      },
    },
  }))
  assert.equal(report.status, 'fail')
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].ruleId, 'example-type-mismatch')
  assert.equal(
    report.findings[0].location.pointer,
    '/paths/~1orders/post/requestBody/content/application~1json/examples/basic/value/customer/contacts/1/email',
  )
  assert.equal(report.findings[0].message.includes('/customer/contacts/1/email'), true)
  assert.equal(report.findings[0].location.file, 'api.json')
})

test('parameters and response headers are examined, and a shared parameter only once', () => {
  const { report } = analyze(description({
    '/orders': {
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 }, example: 0 }],
      get: { responses: { 200: { description: 'ok', headers: { 'X-Total': { schema: { type: 'integer' }, example: 'many' } } } } },
      head: { responses: { 200: { description: 'ok' } } },
    },
  }))
  // Reported in pointer order, so the header under "get" precedes the shared
  // parameter under "parameters" -- "g" before "p", not the order they were read.
  assert.deepEqual(rulesOf(report), ['example-type-mismatch', 'example-out-of-range'])
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/paths/~1orders/get/responses/200/headers/X-Total/example',
    '/paths/~1orders/parameters/0/example',
  ])
  assert.equal(report.summary.operations, 2)
})

/**
 * The schema-missing branch that only a parameter or a header reaches.
 *
 * The media-type level has the same branch and is covered behaviourally, so
 * this one could be suppressed with the whole suite green: the verdict survived
 * -- the run stayed incomplete -- but the report changed to a `schema-malformed`
 * error against `/schema`, a rule id, a severity, a pointer and two counts that
 * were all wrong, and nothing noticed. What is stated here is the report, not
 * just the status.
 */
test('a parameter or a header that declares examples but no schema is a warning at its own position', () => {
  const { report } = analyze(description({
    '/orders': {
      get: {
        parameters: [{ name: 'limit', in: 'query', example: 'x' }],
        responses: { 200: { description: 'ok', headers: { 'X-Total': { examples: { one: { value: 1 }, two: { value: 2 } } } } } },
      },
    },
  }))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesOf(report), ['no-examples-declared', 'schema-missing', 'schema-missing'])
  assert.deepEqual(report.findings.map((finding) => [finding.severity, finding.location.pointer]), [
    ['warning', '/paths'],
    ['warning', '/paths/~1orders/get/parameters/0'],
    ['warning', '/paths/~1orders/get/responses/200/headers/X-Total'],
  ])
  assert.equal(report.findings[1].message.includes('This parameter declares 1 example(s) but no schema'), true, report.findings[1].message)
  assert.equal(report.findings[2].message.includes('This header declares 2 example(s) but no schema'), true, report.findings[2].message)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 3)
  assert.equal(report.summary.examples, 0, 'an example with nothing to check it against is not an example this run examined')
  assert.equal(report.summary.checked, 0)
})

test('an example reached through a reference is pointed at where the value really lives', () => {
  const { report } = analyze(description(response({
    'application/json': {
      schema: { type: 'integer' },
      examples: { shared: { $ref: '#/components/examples/shared' } },
    },
  }), { components: { examples: { shared: { value: 'not a number' } } } }))
  assert.deepEqual(rulesOf(report), ['example-type-mismatch'])
  assert.equal(report.findings[0].location.pointer, '/components/examples/shared/value')
})

test('declaring both example and examples is reported, and both are still checked', () => {
  const { report } = analyze(description(response({
    'application/json': { schema: { type: 'integer' }, example: 'a', examples: { other: { value: 'b' } } },
  })))
  assert.deepEqual(rulesOf(report).sort(), ['example-declaration-conflict', 'example-type-mismatch', 'example-type-mismatch'])
  assert.equal(report.summary.checked, 2)
})

test('a description with no example at all is incomplete, not a pass', () => {
  const { report } = analyze(description({ '/orders': { get: { responses: { 200: { description: 'ok' } } } } }))
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rulesOf(report), ['no-examples-declared'])
  assert.equal(report.findings[0].severity, 'warning')
})

test('an example whose schema could not be fully evaluated is counted as declared, never as checked', () => {
  const { report } = analyze(description(response({
    'application/json': { schema: { type: 'object', unevaluatedProperties: false }, example: { a: 1 } },
  })))
  assert.equal(report.summary.examples, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unknown, 2)
})

test('configuration faults throw instead of becoming findings, because the run had no subject', () => {
  assert.throws(() => analyzeOpenApi({ bytes: new Uint8Array(), sources: 'x' }), /Unknown option "sources"/)
  assert.throws(() => analyzeOpenApi({ bytes: new Uint8Array(), limits: { maxExample: 1 } }), /Unknown limit/)
  assert.throws(() => analyzeOpenApi({ bytes: new Uint8Array(), clock: 5 }), /clock must be a function/)
  assert.throws(() => analyzeOpenApi({ bytes: new Uint8Array(), clock: () => 'soon' }), /finite number/)
  assert.throws(() => analyzeOpenApi([]), /Options must be an object/)
})

test('a 3.0 description is validated by 3.0 rules', () => {
  const { report, version } = analyze({
    openapi: '3.0.3',
    info: { title: 'Orders', version: '1' },
    paths: response({ 'application/json': { schema: { type: 'string', nullable: true }, example: null } }),
  })
  assert.equal(version, '3.0.3')
  assert.equal(report.status, 'pass')
})

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

test('a file that cannot be read produces an incomplete report, not a thrown error', async () => {
  workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-api-'))
  const { report } = await validateOpenApiFile(join(workspace, 'absent.json'), { source: 'absent.json' })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesOf(report), ['document-unreadable'])
  assert.equal(report.findings[0].evidence, 'ENOENT')
  assert.equal(report.findings[0].location.file, 'absent.json')
})

test('a file that can be read is analysed from its bytes', async () => {
  workspace = workspace ?? await mkdtemp(join(tmpdir(), 'openapi-example-validator-api-'))
  const path = join(workspace, 'api.json')
  await writeFile(path, JSON.stringify(description(response({ 'application/json': { schema: { type: 'string' }, example: 7 } }))))
  const { report } = await validateOpenApiFile(path, { source: 'api.json' })
  assert.equal(report.status, 'fail')
  assert.deepEqual(rulesOf(report), ['example-type-mismatch'])
})
