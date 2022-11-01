import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'openapi-example-validator.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself. Asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand in a test,
 * is three declarations agreeing with each other, and one coordinated edit
 * satisfies all three.
 *
 * A behavioural test can be a fourth mirror: drive the real command line, then
 * compare the result against `CASES[i].severity` -- a value in a map the same
 * edit touches. Elsewhere in this catalog that left 40 of 52 error rules green
 * under exactly that flip.
 *
 * So this file shares nothing. It imports nothing from `src/`. There is no table
 * of cases, no expectation computed from one, and no expectation named once and
 * reused. The helpers below build *inputs*; every expectation is a literal
 * written at its own assertion:
 *
 * - the **exit code**, which no edit to a table can change;
 * - the **status** the report declares;
 * - the exact set of rule ids the run emitted, so a fixture cannot be carried
 *   by some other rule;
 * - `errors`, `warnings`, `info` and `checked`, as literal counts;
 * - the **severity word the human report prints**, read off stdout.
 *
 * For a rule that also marks the run incomplete the exit code is 2 whatever the
 * severity, so there the literal counts and the printed word are what hold it:
 * downgrade `ref-cycle` to a warning and `errors` goes from 1 to 0, `warnings`
 * from 0 to 1, and the line a person reads starts with WARNING.
 *
 * `test/severity-table.test.mjs` checks that every rule in the table has a case
 * here, so a rule cannot be added without one.
 */

/**
 * A control operation with one example that is checked and accepted.
 *
 * It is an input, not an expectation. Without it a fixture whose own example is
 * never checked would also trip `no-examples-declared`, and each test below
 * would be asserting two rules instead of the one it is about.
 */
const CONTROL = {
  '/control': {
    get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string' }, example: 'ok' } } } } },
  },
}

const doc = (paths, extra = {}) => ({ openapi: '3.1.0', info: { title: 'Severity', version: '1' }, paths: { ...CONTROL, ...paths }, ...extra })
const media = (content) => ({ '/subject': { get: { responses: { 200: { description: 'd', content } } } } })
const json = (schema, example) => media({ 'application/json': { schema, example } })

let workspace = null
async function directory() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-severity-'))
  return workspace
}
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

/**
 * Run one description through the real command line, twice: once for the
 * machine-readable report and once for the words a person reads.
 *
 * Nothing here carries an expectation. It writes the bytes, runs the binary and
 * hands back what came out. A `null` description is one that was never written,
 * which is how the unreadable case is reached; raw bytes reach the undecodable
 * one; anything else is serialised as JSON.
 */
async function run(name, document, flags = []) {
  const path = join(await directory(), `${name}.json`)
  if (document !== null) {
    if (typeof document === 'string') await writeFile(path, document)
    else if (document instanceof Uint8Array) await writeFile(path, document)
    else await writeFile(path, JSON.stringify(document))
  }
  const machine = await runCli(['--spec', path, '--json', ...flags])
  const human = await runCli(['--spec', path, ...flags])
  const report = JSON.parse(machine.stdout)
  return {
    exitCode: machine.code,
    humanExitCode: human.code,
    report,
    rules: [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    line: (ruleId) => human.stdout.split('\n').find((entry) => entry.includes(` ${ruleId} `)) ?? '',
  }
}

test('document-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-malformed', '{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":7}')
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-malformed', 'no-examples-declared'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-malformed').startsWith('ERROR'), true, outcome.line('document-malformed'))
})

test('document-not-json is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-not-json', 'not json at all')
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-not-json'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-not-json').startsWith('ERROR'), true, outcome.line('document-not-json'))
})

test('document-not-utf8 is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-not-utf8', new Uint8Array([0x7b, 0xff, 0x7d]))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-not-utf8'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-not-utf8').startsWith('ERROR'), true, outcome.line('document-not-utf8'))
})

test('document-too-deep is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-too-deep', doc(json({ type: 'string' }, 'ok')), ['--max-depth', '3'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-too-deep'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-too-deep').startsWith('ERROR'), true, outcome.line('document-too-deep'))
})

test('document-too-large is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-too-large', doc(json({ type: 'string' }, 'ok')), ['--max-bytes', '1'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-too-large'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-too-large').startsWith('ERROR'), true, outcome.line('document-too-large'))
})

test('document-unreadable is an error on a run that exits 2 either way', async () => {
  const outcome = await run('document-unreadable', null)
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['document-unreadable'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('document-unreadable').startsWith('ERROR'), true, outcome.line('document-unreadable'))
})

test('example-additional-property is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-additional-property',
    doc(json({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { a: 'x', b: 'y' })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-additional-property'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-additional-property').startsWith('ERROR'), true, outcome.line('example-additional-property'))
})

test('example-any-of-unsatisfied is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-any-of-unsatisfied',
    doc(json({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true)),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-any-of-unsatisfied'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-any-of-unsatisfied').startsWith('ERROR'), true, outcome.line('example-any-of-unsatisfied'))
})

test('example-const-mismatch is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-const-mismatch', doc(json({ const: 'a' }, 'b')))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-const-mismatch'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-const-mismatch').startsWith('ERROR'), true, outcome.line('example-const-mismatch'))
})

test('example-declaration-conflict is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-declaration-conflict',
    doc(media({ 'application/json': { schema: { type: 'string' }, example: 'a', examples: { other: { value: 'b' } } } })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-declaration-conflict'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 3)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-declaration-conflict').startsWith('ERROR'), true, outcome.line('example-declaration-conflict'))
})

test('example-duplicate-items is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-duplicate-items',
    doc(json({ type: 'array', uniqueItems: true, items: { type: 'string' } }, ['a', 'a'])),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-duplicate-items'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-duplicate-items').startsWith('ERROR'), true, outcome.line('example-duplicate-items'))
})

test('example-enum-mismatch is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-enum-mismatch', doc(json({ enum: ['a', 'b'] }, 'c')))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-enum-mismatch'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-enum-mismatch').startsWith('ERROR'), true, outcome.line('example-enum-mismatch'))
})

test('example-external-value is a warning that on its own makes the run incomplete', async () => {
  const outcome = await run(
    'example-external-value',
    doc(media({ 'application/json': { schema: { type: 'string' }, examples: { e: { externalValue: 'https://example.invalid/e.json' } } } })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['example-external-value'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('example-external-value').startsWith('WARNING'), true, outcome.line('example-external-value'))
})

test('example-format-invalid is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-format-invalid', doc(json({ type: 'string', format: 'date' }, '2024-02-30')))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-format-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-format-invalid').startsWith('ERROR'), true, outcome.line('example-format-invalid'))
})

test('example-length-invalid is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-length-invalid', doc(json({ type: 'string', maxLength: 1 }, 'abc')))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-length-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-length-invalid').startsWith('ERROR'), true, outcome.line('example-length-invalid'))
})

test('example-not-text is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-not-text',
    doc(media({ 'text/plain': { schema: { type: 'string' }, example: { a: 1 } } })),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-not-text'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-not-text').startsWith('ERROR'), true, outcome.line('example-not-text'))
})

test('example-one-of-ambiguous is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-one-of-ambiguous',
    doc(json({ oneOf: [{ type: 'string' }, { minLength: 1 }] }, 'ab')),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-one-of-ambiguous'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-one-of-ambiguous').startsWith('ERROR'), true, outcome.line('example-one-of-ambiguous'))
})

test('example-one-of-unsatisfied is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'example-one-of-unsatisfied',
    doc(json({ oneOf: [{ type: 'string' }, { type: 'number' }] }, true)),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-one-of-unsatisfied'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-one-of-unsatisfied').startsWith('ERROR'), true, outcome.line('example-one-of-unsatisfied'))
})

test('example-out-of-range is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-out-of-range', doc(json({ type: 'integer', minimum: 5 }, 1)))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-out-of-range'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-out-of-range').startsWith('ERROR'), true, outcome.line('example-out-of-range'))
})

test('example-pattern-mismatch is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-pattern-mismatch', doc(json({ type: 'string', pattern: '^[a-z]+$' }, 'A1')))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-pattern-mismatch'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-pattern-mismatch').startsWith('ERROR'), true, outcome.line('example-pattern-mismatch'))
})

test('example-required-missing is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-required-missing', doc(json({ type: 'object', required: ['a'] }, {})))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-required-missing'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-required-missing').startsWith('ERROR'), true, outcome.line('example-required-missing'))
})

test('example-too-deep is an error on a run that exits 2 either way', async () => {
  const outcome = await run('example-too-deep', doc(json({ type: 'object' }, { a: 1 })), ['--max-example-depth', '1'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['example-too-deep'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('example-too-deep').startsWith('ERROR'), true, outcome.line('example-too-deep'))
})

test('example-too-large is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'example-too-large',
    doc(json({ type: 'string' }, 'aaaaaaa')),
    ['--max-example-bytes', '4'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['example-too-large'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('example-too-large').startsWith('ERROR'), true, outcome.line('example-too-large'))
})

test('example-type-mismatch is an error: the run fails and the command exits 1', async () => {
  const outcome = await run('example-type-mismatch', doc(json({ type: 'string' }, 7)))
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['example-type-mismatch'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('example-type-mismatch').startsWith('ERROR'), true, outcome.line('example-type-mismatch'))
})

test('format-not-asserted is information: the run still passes and the command exits 0', async () => {
  const outcome = await run('format-not-asserted', doc(json({ type: 'string', format: 'email' }, 'a@b')))
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.report.status, 'pass')
  assert.deepEqual(outcome.rules, ['format-not-asserted'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 1)
  assert.equal(outcome.report.summary.checked, 2)
  assert.equal(outcome.humanExitCode, 0)
  assert.equal(outcome.line('format-not-asserted').startsWith('INFO'), true, outcome.line('format-not-asserted'))
})

test('media-type-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'media-type-unsupported',
    doc(media({ 'application/xml': { schema: { type: 'string' }, example: '<a/>' } })),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['media-type-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('media-type-unsupported').startsWith('ERROR'), true, outcome.line('media-type-unsupported'))
})

test('no-examples-declared is a warning that on its own makes the run incomplete', async () => {
  const outcome = await run(
    'no-examples-declared',
    { openapi: '3.1.0', info: { title: 'Severity', version: '1' }, paths: {} },
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['no-examples-declared'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('no-examples-declared').startsWith('WARNING'), true, outcome.line('no-examples-declared'))
})

test('node-budget-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run('node-budget-exceeded', doc(json({ type: 'string' }, 'ok')), ['--max-nodes', '1'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['no-examples-declared', 'node-budget-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('node-budget-exceeded').startsWith('ERROR'), true, outcome.line('node-budget-exceeded'))
})

test('openapi-version-missing is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'openapi-version-missing',
    { info: { title: 'Severity', version: '1' }, paths: { ...CONTROL } },
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['openapi-version-missing'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('openapi-version-missing').startsWith('ERROR'), true, outcome.line('openapi-version-missing'))
})

test('openapi-version-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'openapi-version-unsupported',
    { openapi: '2.0.0', info: { title: 'Severity', version: '1' }, paths: { ...CONTROL } },
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['openapi-version-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('openapi-version-unsupported').startsWith('ERROR'), true, outcome.line('openapi-version-unsupported'))
})

test('operation-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('operation-malformed', doc({ '/subject': { get: 7 } }))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['operation-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('operation-malformed').startsWith('ERROR'), true, outcome.line('operation-malformed'))
})

test('ref-cycle is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'ref-cycle',
    doc(json({ $ref: '#/components/schemas/Loop' }, 1), { components: { schemas: { Loop: { $ref: '#/components/schemas/Mirror' }, Mirror: { $ref: '#/components/schemas/Loop' } } } }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-cycle'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-cycle').startsWith('ERROR'), true, outcome.line('ref-cycle'))
})

test('ref-depth-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'ref-depth-exceeded',
    doc(json({ $ref: '#/components/schemas/Alias' }, 1), { components: { schemas: { Alias: { $ref: '#/components/schemas/Number' }, Number: { type: 'integer' } } } }),
    ['--max-ref-depth', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-depth-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-depth-exceeded').startsWith('ERROR'), true, outcome.line('ref-depth-exceeded'))
})

test('ref-external-file-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run('ref-external-file-unsupported', doc(json({ $ref: './other.json#/Pet' }, 1)))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-external-file-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-external-file-unsupported').startsWith('ERROR'), true, outcome.line('ref-external-file-unsupported'))
})

test('ref-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('ref-malformed', doc(json({ $ref: '#Pet' }, 1)))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-malformed').startsWith('ERROR'), true, outcome.line('ref-malformed'))
})

test('ref-remote-refused is an error on a run that exits 2 either way', async () => {
  const outcome = await run('ref-remote-refused', doc(json({ $ref: 'https://example.invalid/s.json' }, 1)))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-remote-refused'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-remote-refused').startsWith('ERROR'), true, outcome.line('ref-remote-refused'))
})

test('ref-unresolved is an error on a run that exits 2 either way', async () => {
  const outcome = await run('ref-unresolved', doc(json({ $ref: '#/components/schemas/Nope' }, 1)))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['ref-unresolved'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('ref-unresolved').startsWith('ERROR'), true, outcome.line('ref-unresolved'))
})

test('schema-dialect-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'schema-dialect-unsupported',
    doc(json({ type: 'string', $schema: 'http://json-schema.org/draft-07/schema#' }, 'x')),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-dialect-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-dialect-unsupported').startsWith('ERROR'), true, outcome.line('schema-dialect-unsupported'))
})

test('schema-keyword-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run('schema-keyword-unsupported', doc(json({ type: 'object', patternProperties: {} }, {})))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-keyword-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-keyword-unsupported').startsWith('ERROR'), true, outcome.line('schema-keyword-unsupported'))
})

test('schema-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('schema-malformed', doc(json({ type: 'string', maxLength: '3' }, 'abc')))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-malformed').startsWith('ERROR'), true, outcome.line('schema-malformed'))
})

test('schema-missing is a warning that on its own makes the run incomplete', async () => {
  const outcome = await run('schema-missing', doc(media({ 'application/json': { example: 'x' } })))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-missing'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-missing').startsWith('WARNING'), true, outcome.line('schema-missing'))
})

test('schema-pattern-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run('schema-pattern-invalid', doc(json({ type: 'string', pattern: '[' }, 'a')))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-pattern-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-pattern-invalid').startsWith('ERROR'), true, outcome.line('schema-pattern-invalid'))
})

test('schema-pattern-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run('schema-pattern-unsupported', doc(json({ type: 'string', pattern: '^(a+)+$' }, 'a')))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-pattern-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-pattern-unsupported').startsWith('ERROR'), true, outcome.line('schema-pattern-unsupported'))
})

test('schema-too-deep is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'schema-too-deep',
    doc(json({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } }, { a: { b: 1 } })),
    ['--max-eval-depth', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-too-deep'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-too-deep').startsWith('ERROR'), true, outcome.line('schema-too-deep'))
})

test('schema-type-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run('schema-type-invalid', doc(json({ type: 'strings' }, 'x')))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-type-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-type-invalid').startsWith('ERROR'), true, outcome.line('schema-type-invalid'))
})

test('time-budget-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run('time-budget-exceeded', doc(json({ type: 'string' }, 'ok')), ['--max-millis', '0'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['time-budget-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('time-budget-exceeded').startsWith('ERROR'), true, outcome.line('time-budget-exceeded'))
})

test('too-many-examples is an error on a run that exits 2 either way', async () => {
  const outcome = await run('too-many-examples', doc(json({ type: 'string' }, 'x')), ['--max-examples', '1'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-examples'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-examples').startsWith('ERROR'), true, outcome.line('too-many-examples'))
})

test('too-many-operations is an error on a run that exits 2 either way', async () => {
  const outcome = await run('too-many-operations', doc(json({ type: 'string' }, 'x')), ['--max-operations', '1'])
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-operations'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.report.summary.checked, 1)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-operations').startsWith('ERROR'), true, outcome.line('too-many-operations'))
})
