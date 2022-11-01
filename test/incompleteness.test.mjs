import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'openapi-example-validator.mjs')

/**
 * The membership of INCOMPLETE_RULES, pinned where it actually matters.
 *
 * One `incomplete = true` site decides whether a run that could not answer its
 * question reports a verdict anyway. For an `error` rule, removing an id from
 * that list turns exit 2 into exit 1, and every case in
 * `test/severity-behaviour.test.mjs` states its exit code as a literal, so all
 * twenty-nine of those are already pinned there.
 *
 * The three `warning` rules are the dangerous ones. Their severity alone would
 * not stop a pass -- a warning is not an error -- so for them the membership is
 * the *only* thing between a run that checked nothing and a green build. Each
 * gets a case here that asserts exit 0 is not what happens.
 */

let workspace = null
async function directory() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-incomplete-'))
  return workspace
}
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

async function run(name, document) {
  const path = join(await directory(), `${name}.json`)
  await writeFile(path, JSON.stringify(document))
  const result = await execFileAsync(process.execPath, [cli, '--spec', path, '--json'], { cwd: projectDirectory })
    .then((value) => ({ code: 0, ...value }), (error) => ({ code: error.code, stdout: error.stdout }))
  return { code: result.code, report: JSON.parse(result.stdout) }
}

const description = (paths, extra = {}) => ({ openapi: '3.1.0', info: { title: 'Gaps', version: '1' }, paths, ...extra })
const site = (media) => ({ '/orders': { get: { responses: { 200: { description: 'ok', content: { 'application/json': media } } } } } })

test('no-examples-declared: a run that checked nothing is not allowed to pass', async () => {
  const outcome = await run('no-examples', description({ '/orders': { get: { responses: { 200: { description: 'ok' } } } } }))
  assert.equal(outcome.code, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.checked, 0)
  assert.notEqual(outcome.code, 0, 'a warning alone would have exited 0; the incompleteness is what does not')
})

test('schema-missing: an example with nothing to check it against is not a pass', async () => {
  const outcome = await run('schema-missing', description(site({ example: 'anything at all' })))
  assert.equal(outcome.code, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 2)
  assert.notEqual(outcome.code, 0)
})

test('example-external-value: a value that was never fetched is not a value that was checked', async () => {
  const outcome = await run('external', description(site({
    schema: { type: 'string' },
    examples: { local: { value: 'here' }, remote: { externalValue: 'https://example.invalid/e.json' } },
  })))
  assert.equal(outcome.code, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.checked, 1, 'the inline example really was checked')
  assert.notEqual(outcome.code, 0)
})

test('the warning rules really are the only three that could pass without the incomplete flag', () => {
  const warnings = INCOMPLETE_RULES.filter((ruleId) => RULE_SEVERITY[ruleId] !== 'error')
  assert.deepEqual(warnings.sort(), ['example-external-value', 'no-examples-declared', 'schema-missing'])
})

test('every rule that makes a run incomplete is driven to an incomplete status somewhere', async () => {
  const text = await (await import('node:fs/promises')).readFile(resolve(projectDirectory, 'test/severity-behaviour.test.mjs'), 'utf8')
  const blocks = text.split('\ntest(').slice(1)
  const incompleteCases = new Set()
  for (const block of blocks) {
    const name = /'([a-z0-9-]+) is /.exec(block)
    if (name !== null && block.includes("assert.equal(outcome.report.status, 'incomplete')")) incompleteCases.add(name[1])
  }
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(incompleteCases.has(ruleId), `${ruleId} is in INCOMPLETE_RULES but no case asserts an incomplete status for it`)
  }
})

test('a run with findings but no gap is a verdict, so the distinction is not vacuous', async () => {
  const outcome = await run('verdict', description(site({ schema: { type: 'integer' }, example: 'four' })))
  assert.equal(outcome.code, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.equal(outcome.report.summary.unknown, 0)
})
