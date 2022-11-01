import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILES = ['src/text.mjs', 'src/pointer.mjs', 'src/document.mjs', 'src/refs.mjs', 'src/schema.mjs', 'src/index.mjs']

/**
 * The table, the documented catalog and the shipped source agree.
 *
 * This is a consistency check, not the severity guard. Three declarations
 * agreeing with each other can all be edited together, and a catalog where that
 * was the only defence had forty error rules survive being flipped to warnings.
 * The guard is `test/severity-behaviour.test.mjs`, which drives every rule
 * through the real command line and states each outcome as a literal.
 *
 * What lives here is the one thing that guard cannot check about itself: that it
 * has a case for every rule, that every rule it covers really is pinned by an
 * exit code or a literal count, and that it still imports nothing from `src/`. A
 * guard that imported the table would be a fourth declaration agreeing with the
 * other three.
 */

const readProjectFile = (relativePath) => readFile(resolve(projectDirectory, relativePath), 'utf8')

async function documentedRules() {
  const text = await readProjectFile('docs/example-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|\s*(yes|no)\s*\|/g)]
  return rows.map(([, ruleId, severity, incomplete]) => ({ ruleId, severity, incomplete: incomplete === 'yes' }))
}

test('the documented catalog and the severity table list the same rules, with the same severities', async () => {
  const documented = await documentedRules()
  assert.equal(documented.length, 48)
  assert.deepEqual(
    documented.map((row) => row.ruleId).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/example-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(Object.fromEntries(documented.map((row) => [row.ruleId, row.severity])), { ...RULE_SEVERITY })
})

test('the documented incomplete column and INCOMPLETE_RULES agree in both directions', async () => {
  const documented = await documentedRules()
  assert.deepEqual(
    documented.filter((row) => row.incomplete).map((row) => row.ruleId).sort(),
    [...INCOMPLETE_RULES].sort(),
  )
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} marks a run incomplete but has no severity`)
  }
  assert.equal(INCOMPLETE_RULES.length, 32)
})

test('every rule in the table has a case of its own in the behavioural guard', async () => {
  const text = await readProjectFile('test/severity-behaviour.test.mjs')
  assert.equal(text.includes("from '../src/"), false, 'the behavioural guard imports the table it exists to defend')
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(text, new RegExp(`await run\\(\\s*\\n?\\s*'${ruleId}'`), `${ruleId} has no case in test/severity-behaviour.test.mjs`)
  }
  assert.equal(Object.keys(RULE_SEVERITY).length, 48)
})

test('each case in the behavioural guard states the exit code, the counts and the printed word', async () => {
  const text = await readProjectFile('test/severity-behaviour.test.mjs')
  const blocks = text.split('\ntest(').slice(1)
  assert.equal(blocks.length, 48)
  for (const block of blocks) {
    const name = /'([a-z0-9-]+) is /.exec(block)
    assert.notEqual(name, null, 'a case with no rule id in its title')
    assert.match(block, /assert\.equal\(outcome\.exitCode, [012]\)/, `${name[1]} does not pin an exit code`)
    assert.match(block, /assert\.equal\(outcome\.report\.summary\.errors, \d+\)/, `${name[1]} does not pin an error count`)
    assert.match(block, /assert\.equal\(outcome\.report\.summary\.warnings, \d+\)/, `${name[1]} does not pin a warning count`)
    assert.match(block, /startsWith\('(ERROR|WARNING|INFO)'\)/, `${name[1]} does not pin the printed severity word`)
    assert.equal(block.includes('severity'), block.includes('does not pin'), `${name[1]} compares a severity field instead of an outcome`)
  }
})

test('every rule the source emits is in the severity table', async () => {
  const sources = await Promise.all(SOURCE_FILES.map((path) => readProjectFile(path)))
  const text = sources.join('\n')
  const emitted = new Set([
    ...[...text.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]),
    ...[...text.matchAll(/[Pp]roblem\(\s*(?:state,\s*)?'([a-z0-9-]+)'/g)].map((match) => match[1]),
    ...[...text.matchAll(/halt\(state,\s*'([a-z0-9-]+)'/g)].map((match) => match[1]),
  ])
  assert.ok(emitted.size > 35, `the rule scan found suspiciously few construction sites: ${emitted.size}`)
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('every rule in the table is one the source can actually emit', async () => {
  const sources = await Promise.all(SOURCE_FILES.map((path) => readProjectFile(path)))
  const text = sources.join('\n')
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(text.includes(`'${ruleId}'`), `${ruleId} is declared but no source file names it`)
  }
})

test('every documented limit is a real limit, and every real limit is wired to the flag it claims', async () => {
  const text = await readProjectFile('docs/example-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map(([, name, , value]) => [name, Number(value)]))
  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const help = await readProjectFile('bin/openapi-example-validator.mjs')
  for (const [, name, flag] of rows) {
    assert.ok(help.includes(`['${flag}', '${name}']`), `${name} is documented as ${flag}, which the CLI does not map to it`)
    assert.ok(help.includes(`  ${flag} `), `${flag} is not listed in --help`)
  }
})

test('the README states how many rules make a run incomplete, and states it right', async () => {
  const text = await readProjectFile('README.md')
  const stated = /\| (\d+) rules, every one of which makes the run `incomplete` \|/.exec(text)
  assert.notEqual(stated, null, 'the README no longer says how many rules make a run incomplete')
  assert.equal(Number(stated[1]), INCOMPLETE_RULES.length)
})
