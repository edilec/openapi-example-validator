import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, analyzeOpenApi } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'openapi-example-validator.mjs')

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly, so
 * the grep stays green while the report order starts depending on the ICU data
 * of whichever host ran it. Every identifier below is chosen so that code-unit
 * order and collation order genuinely disagree:
 *
 * - a collator folds case, so it puts `assets` before `README` and before `Z`;
 * - a collator weighs `-` and `_` differently from their code points, so it puts
 *   `a_b` before `a-b` while the code units put `a-b` first.
 *
 * Code units give one answer: R(0x52), Z(0x5A), a(0x61); then `a` before `a-b`
 * because it is a prefix; then `-`(0x2D) before `_`(0x5F) before `s`(0x73).
 *
 * The source has exactly three `byCodeUnit` call sites, and there is a case here
 * for each:
 *
 * | site | what it orders | case below |
 * | --- | --- | --- |
 * | `compareFindingRows` pointer | the whole report | the unknown keywords, the path templates, the extra properties |
 * | `compareFindingRows` ruleId | two findings at one pointer | the spent budget, plus the equivalence proof |
 * | `rotateCycle` | where a reference cycle is written from | the cycle |
 *
 * Substitute `new Intl.Collator('en').compare` at the pointer site or the
 * rotation site and these assertions go red. The rule-id site is different, and
 * the last test in this file is why.
 */

const CODE_UNIT_ORDER = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']
// Declaration order is deliberately the reverse of the answer.
const DECLARED = [...CODE_UNIT_ORDER].reverse()

function analyze(document, limits) {
  return analyzeOpenApi({ bytes: new TextEncoder().encode(JSON.stringify(document)), source: 'ordering.json', limits }).report
}

function description(paths, extra = {}) {
  return { openapi: '3.1.0', info: { title: 'Ordering', version: '1' }, paths, ...extra }
}

const site = (media) => ({ '/p': { get: { responses: { 200: { description: 'ok', content: { 'application/json': media } } } } } })

test('unknown schema keywords reach the report in code-unit order of their pointer', () => {
  const schema = { type: 'object' }
  for (const keyword of DECLARED) schema[keyword] = true
  const report = analyze(description(site({ schema, example: {} })))
  const keywords = report.findings
    .filter((finding) => finding.ruleId === 'schema-keyword-unsupported')
    .map((finding) => finding.location.pointer.split('/').pop())
  assert.deepEqual(keywords, CODE_UNIT_ORDER)
})

/**
 * A path template is followed by more pointer, so the comparison continues past
 * it and lands on the separator. `a-b` beats `a` because at the second character
 * it is `-` (0x2D) against `/` (0x2F) -- a third answer, different from both the
 * collated order and the order of the templates on their own, which is exactly
 * why it is written out literally here.
 */
test('path templates are ordered by the whole pointer, separator included', () => {
  const paths = {}
  for (const template of DECLARED) {
    paths[`/${template}`] = {
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'integer' }, example: 'no' } } } } },
    }
  }
  const report = analyze(description(paths))
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/paths/~1README/get/responses/200/content/application~1json/example',
    '/paths/~1Z/get/responses/200/content/application~1json/example',
    '/paths/~1a-b/get/responses/200/content/application~1json/example',
    '/paths/~1a/get/responses/200/content/application~1json/example',
    '/paths/~1a_b/get/responses/200/content/application~1json/example',
    '/paths/~1assets/get/responses/200/content/application~1json/example',
  ])
})

test('properties the schema does not declare are reported in code-unit order', () => {
  const example = {}
  for (const property of DECLARED) example[property] = 1
  const report = analyze(description(site({ schema: { type: 'object', additionalProperties: false }, example })))
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer.split('/').pop()),
    CODE_UNIT_ORDER,
  )
})

test('the human report lists findings in the same order the JSON report does', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-order-'))
  try {
    const example = {}
    for (const property of DECLARED) example[property] = 1
    const path = join(workspace, 'ordering.json')
    await writeFile(path, JSON.stringify(description(site({ schema: { type: 'object', additionalProperties: false }, example }))))
    const human = await execFileAsync(process.execPath, [cli, '--spec', path]).catch((error) => error)
    const reported = human.stdout.trimEnd().split('\n').slice(1).map((line) => line.split(' ').filter(Boolean)[1].split('/').pop())
    assert.deepEqual(reported, CODE_UNIT_ORDER)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/**
 * A cycle has no inherent first member, so it is rooted at its code-unit
 * smallest one. `Z` wins that against `a` by code unit and loses it to a
 * collator, so the evidence string below is the whole test.
 */
test('a reference cycle is written from its code-unit-smallest member', () => {
  const withCycle = analyze(description(site({ schema: { $ref: '#/components/schemas/a' }, example: 1 }), {
    components: { schemas: { a: { $ref: '#/components/schemas/Z' }, Z: { $ref: '#/components/schemas/a' } } },
  }))
  const cycle = withCycle.findings.find((finding) => finding.ruleId === 'ref-cycle')
  assert.equal(cycle.evidence, '/components/schemas/Z -> /components/schemas/a -> /components/schemas/Z')
})

test('two findings at one pointer are separated by their rule id', () => {
  const report = analyze(description(site({ schema: { type: 'integer' }, example: 1 })), { maxNodes: 1 })
  const atPaths = report.findings.filter((finding) => finding.location.pointer === '/paths')
  assert.deepEqual(atPaths.map((finding) => finding.ruleId), ['no-examples-declared', 'node-budget-exceeded'])
})

/**
 * The rule-id comparison is an **equivalent mutant**, and this is the proof
 * rather than an excuse.
 *
 * Every rule id is drawn from `[a-z0-9-]`. Over that alphabet, and over these
 * forty-eight actual values, code-unit order and collation order agree on every
 * one of the 2256 ordered pairs -- so no document can produce two findings whose
 * relative order changes when that one call is swapped for a collator. The site
 * is reachable (the test above reaches it); it is simply not observable.
 *
 * This is the only place in the repository where a collator appears, and it is
 * an assertion *about* the equivalence class rather than a use of one. If a host
 * shipped ICU data that disagreed, this test would go red -- which is the right
 * outcome, because on that host the mutant would no longer be equivalent and the
 * site would need pinning like the other two.
 */
test('the rule-id comparison is provably unobservable over the real rule ids', () => {
  const ids = Object.keys(RULE_SEVERITY)
  assert.equal(ids.length, 48)
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/)

  const collate = new Intl.Collator('en').compare
  const byCodeUnit = (left, right) => (left === right ? 0 : left < right ? -1 : 1)
  let pairs = 0
  for (const left of ids) {
    for (const right of ids) {
      if (left === right) continue
      pairs += 1
      assert.equal(
        Math.sign(byCodeUnit(left, right)),
        Math.sign(collate(left, right)),
        `${left} and ${right} order differently under collation, so that call site is pinnable after all`,
      )
    }
  }
  assert.equal(pairs, 2256)
})

test('the values these cases are built from really do collate differently', () => {
  const collate = new Intl.Collator('en').compare
  assert.deepEqual([...CODE_UNIT_ORDER].sort(collate), ['a', 'a_b', 'a-b', 'assets', 'README', 'Z'])
  assert.notDeepEqual([...CODE_UNIT_ORDER].sort(collate), CODE_UNIT_ORDER)
})

after(() => {})
