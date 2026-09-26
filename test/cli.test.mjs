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

let workspace = null
async function directory() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-cli-'))
  return workspace
}
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory, ...options })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

async function withSpec(name, document, args = []) {
  const path = join(await directory(), `${name}.json`)
  await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document))
  return runCli(['--spec', path, ...args])
}

const description = (content) => ({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: { '/orders': { get: { responses: { 200: { description: 'ok', content } } } } },
})

test('--help goes to stdout and exits 0', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.startsWith('openapi-example-validator'), true)
  assert.equal(result.stdout.includes('--max-example-depth'), true)
  assert.equal(result.stderr, '')
})

test('a satisfied description exits 0, and stdout is nothing but the report', async () => {
  const result = await runCli(['--spec', 'examples/petstore.json', '--json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 7)
  assert.equal(report.findings.length, 0)
  assert.equal(result.stderr.length > 0, true, 'diagnostics belong on stderr and a non-empty stderr is correct')
})

test('a contradicted description exits 1 and names every position', async () => {
  const result = await runCli(['--spec', 'examples/broken-petstore.json', '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 11)
  assert.equal(
    report.findings[0].location.pointer,
    '/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/0/birthday',
  )
  // The equality is the whole claim: a relative label, so no absolute host path
  // reaches a report people paste into issues. The two cases below drive the
  // same guarantee from an absolute input, where it can go red on its own.
  for (const finding of report.findings) assert.equal(finding.location.file, 'examples/broken-petstore.json')
})

test('a description full of unanswerable questions exits 2 with an incomplete report', async () => {
  const result = await runCli(['--spec', 'examples/unresolvable.json', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.unknown > 0, true)
  assert.equal(result.stderr.includes('not a verdict'), true)
})

test('an invalid configuration exits 2 with an empty stdout, because the run had no subject', async () => {
  for (const args of [[], ['--spec'], ['--spec', 'a', '--spec', 'b'], ['--spec', 'a', '--nope'], ['--spec', 'a', '--max-nodes', 'lots'], ['--spec', 'a', '--max-nodes', '0'], ['--spec', 'a', '--json', '--json']]) {
    const result = await runCli(args)
    assert.equal(result.code, 2, `${args.join(' ')} should be a configuration error`)
    assert.equal(result.stdout, '', `${args.join(' ')} wrote to stdout`)
    assert.equal(result.stderr.length > 0, true)
  }
})

test('an unreadable input exits 2 but still writes the report that says which input it was', async () => {
  const result = await runCli(['--spec', join(await directory(), 'absent.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'document-unreadable')
  // The path given was absolute and outside the working directory, so this
  // equality is also what keeps an absolute host path out of the report.
  assert.equal(report.findings[0].location.file, 'absent.json')
})

test('the human report is one line per finding, with the severity first', async () => {
  const result = await withSpec('human', description({ 'application/json': { schema: { type: 'integer' }, example: 'four' } }))
  assert.equal(result.code, 1)
  const lines = result.stdout.trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].startsWith('openapi 3.1.0 "Orders":'), true)
  assert.equal(lines[1].startsWith('ERROR   '), true)
  assert.equal(lines[1].includes(' example-type-mismatch '), true)
})

test('stdout is byte-identical between two runs over the same bytes', async () => {
  const first = await runCli(['--spec', 'examples/broken-petstore.json', '--json'])
  const second = await runCli(['--spec', 'examples/broken-petstore.json', '--json'])
  assert.equal(first.stdout, second.stdout)
})

test('the time budget is wired through from the flag, not merely documented', async () => {
  const result = await withSpec('budget', description({ 'application/json': { schema: { type: 'integer' }, example: 4 } }), ['--max-millis', '0', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['time-budget-exceeded'])
})

test('a description reached by an absolute path outside the working directory is named by its base name', async () => {
  const result = await withSpec('outside', description({ 'application/json': { schema: { type: 'integer' }, example: 'four' } }), ['--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.findings[0].location.file, 'outside.json')
})
