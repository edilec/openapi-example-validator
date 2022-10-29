import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { analyzeOpenApi } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILES = ['src/text.mjs', 'src/pointer.mjs', 'src/document.mjs', 'src/refs.mjs', 'src/schema.mjs', 'src/index.mjs', 'bin/openapi-example-validator.mjs']

const analyze = (document, options = {}) => analyzeOpenApi({
  bytes: new TextEncoder().encode(JSON.stringify(document)),
  source: 'api.json',
  ...options,
}).report

function description(paths, extra = {}) {
  return { openapi: '3.1.0', info: { title: 'Orders', version: '1' }, paths, ...extra }
}

function operation(media) {
  return { get: { responses: { 200: { description: 'ok', content: { 'application/json': media } } } } }
}

const schema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: { id: { type: 'integer' }, name: { type: 'string', maxLength: 2 }, tags: { type: 'array', uniqueItems: true, items: { type: 'string' } } },
}
const value = { id: 'x', name: 'too long', tags: ['a', 'a'], extra: true }

test('the same bytes produce a byte-identical report, twice', () => {
  const first = JSON.stringify(analyze(description({ '/a': operation({ schema, example: value }) })))
  const second = JSON.stringify(analyze(description({ '/a': operation({ schema, example: value }) })))
  assert.equal(first, second)
})

/**
 * The order the description happens to be written in must not reach the report.
 *
 * `JSON.parse` preserves insertion order, so two descriptions that mean the same
 * thing but were written in different orders walk in different orders. Only the
 * sort at the end makes them agree, which is what this compares.
 */
test('rewriting the description in a different order changes nothing in the report', () => {
  const forward = analyze(description({
    '/a': operation({ schema, example: value }),
    '/b': operation({ schema, example: value }),
  }))
  const backward = analyze(description({
    '/b': operation({ schema, example: value }),
    '/a': operation({ schema, example: value }),
  }))
  assert.deepEqual(forward.findings, backward.findings)
  assert.deepEqual(forward.summary, backward.summary)
})

test('reordering the keys of an example changes nothing either', () => {
  const forward = analyze(description({ '/a': operation({ schema, example: { id: 'x', name: 'too long', extra: true } }) }))
  const backward = analyze(description({ '/a': operation({ schema, example: { extra: true, name: 'too long', id: 'x' } }) }))
  assert.deepEqual(forward.findings, backward.findings)
})

/**
 * The clock is injected, and the only thing it can change is whether the budget
 * was spent. Two wildly different clocks that both leave time to spare must
 * produce the same bytes; if a reading ever reached the report, this fails.
 */
test('two different clocks produce the same report, because no reading reaches output', () => {
  const document = description({ '/a': operation({ schema, example: value }) })
  const slow = JSON.stringify(analyze(document, { clock: () => 0 }))
  let tick = 1000000
  const fast = JSON.stringify(analyze(document, { clock: () => (tick += 7) }))
  assert.equal(slow, fast)
})

test('the source reads no wall clock and no randomness', async () => {
  // A secondary check. The behavioural tests above are the guard; this catches
  // a reading that has been added but not yet wired anywhere observable.
  for (const relativePath of SOURCE_FILES) {
    const text = await readFile(resolve(projectDirectory, relativePath), 'utf8')
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')).join('\n')
    for (const forbidden of ['Date.now(', 'new Date(', 'Math.random(', 'localeCompare(', 'Intl.Collator(']) {
      assert.equal(code.includes(forbidden), false, `${relativePath} uses ${forbidden}`)
    }
  }
})
