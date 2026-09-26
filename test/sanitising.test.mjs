import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'openapi-example-validator.mjs')

/**
 * Sanitising, tested where it is actually attacked.
 *
 * Four tools in this catalog stripped C0 and the line separators and let the C1
 * range through, and one sanitised its excerpt field carefully while an
 * identifier carrying a newline forged whole lines in the human report. So every
 * hostile character below arrives through an **identifier** the document's
 * author chose -- a path template, a media type key, an example name, a schema
 * keyword, a required property name, a `$ref` string, a format name, the API
 * title -- and none of them through an excerpt.
 *
 * The strongest assertion here is the line count. The human report is one header
 * plus one line per finding; if any identifier could forge a line, that equality
 * breaks, whatever the character-by-character scan says.
 */

const CLASSES = [
  ['C0 (line feed)', 0x0a],
  ['C0 (escape)', 0x1b],
  ['DEL', 0x7f],
  ['C1 (NEL)', 0x85],
  ['C1 (CSI)', 0x9b],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['bidi (LRM)', 0x200e],
  ['bidi (RLM)', 0x200f],
  ['bidi (LRE)', 0x202a],
  ['bidi (RLO)', 0x202e],
  ['bidi (LRI)', 0x2066],
  ['bidi (PDI)', 0x2069],
]

const character = (codePoint) => String.fromCodePoint(codePoint)
const NEWLINE = character(0x0a)
const NEL = character(0x85)
const CSI = character(0x9b)
const LS = character(0x2028)
const PS = character(0x2029)
const RLO = character(0x202e)
const RLM = character(0x200f)
const PDI = character(0x2069)

const hostile = {
  openapi: '3.1.0',
  info: { title: `Orders${PS}ERROR forged header line`, version: '1' },
  paths: {
    [`/a${NEWLINE}b`]: {
      get: {
        responses: {
          200: {
            description: 'ok',
            content: {
              [`application/json${NEL}`]: { schema: { type: 'string' }, example: 'x' },
              'application/json': {
                schema: { type: 'object', required: [`id${CSI}`], [`weird${LS}key`]: true, properties: {} },
                examples: { [`basic${RLO}`]: { value: {} } },
              },
            },
          },
        },
      },
    },
    '/ref': {
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `https://example.invalid/a${RLM}b.json` }, example: 1 } } } } },
    },
    '/fmt': {
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string', format: `emai${PDI}l` }, example: 'x' } } } } },
    },
  },
}

let workspace = null
let machine = null
let human = null
let report = null

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'openapi-example-validator-sanitise-'))
  const path = join(workspace, 'hostile.json')
  await writeFile(path, JSON.stringify(hostile))
  const run = (args) => execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((value) => value, (error) => error)
  machine = await run(['--spec', path, '--json'])
  human = await run(['--spec', path])
  report = JSON.parse(machine.stdout)
})
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

test('the run produced findings, so the scans below are not scanning an empty report', () => {
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 5)
})

test('no forging character reaches any string in the machine-readable report', () => {
  const strings = []
  const walk = (value) => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(report)
  assert.ok(strings.length > 20)
  for (const [name, codePoint] of CLASSES) {
    for (const value of strings) {
      assert.equal(value.includes(character(codePoint)), false, `${name} survived into ${JSON.stringify(value)}`)
    }
  }
})

test('no forging character reaches the human report either', () => {
  // The report's own line feeds are the line structure, so each line is scanned
  // on its own: a line feed inside one would be a forged line, and the next test
  // is the arithmetic that proves none was.
  for (const line of human.stdout.trimEnd().split(NEWLINE)) {
    for (const [name, codePoint] of CLASSES) {
      assert.equal(line.includes(character(codePoint)), false, `${name} survived into "${line}"`)
    }
  }
})

test('the human report is one header plus one line per finding, so nothing forged a line', () => {
  const lines = human.stdout.trimEnd().split(NEWLINE)
  assert.equal(lines.length, report.findings.length + 1)
  assert.equal(lines[0].startsWith('openapi 3.1.0 "Orders ERROR forged header line"'), true, lines[0])
  for (const line of lines.slice(1)) assert.match(line, /^(ERROR|WARNING|INFO)\s+hostile\.json\//)
})

test('a path template carrying a newline becomes one pointer segment, not two lines', () => {
  const pointers = report.findings.map((finding) => finding.location.pointer)
  assert.equal(pointers.filter((pointer) => pointer.startsWith('/paths/~1a b/')).length, 3)
  assert.equal(pointers.some((pointer) => pointer.includes(NEWLINE)), false)
})

test('a schema keyword carrying a line separator is cleaned in the pointer, the message and the evidence', () => {
  const finding = report.findings.find((entry) => entry.ruleId === 'schema-keyword-unsupported')
  assert.equal(finding.location.pointer.endsWith('/schema/weird key'), true, finding.location.pointer)
  assert.equal(finding.message.includes('"weird key"'), true, finding.message)
  assert.equal(finding.evidence, 'weird key')
})

test('a required property name carrying an 8-bit CSI is cleaned before it reaches the message', () => {
  const finding = report.findings.find((entry) => entry.ruleId === 'example-required-missing')
  assert.equal(finding.message.includes('"id"'), true, finding.message)
  assert.equal(finding.location.pointer.endsWith('/value/id'), true, finding.location.pointer)
})

test('an example name carrying a right-to-left override is cleaned in the pointer', () => {
  const finding = report.findings.find((entry) => entry.ruleId === 'example-required-missing')
  assert.equal(finding.location.pointer.includes('/examples/basic/'), true, finding.location.pointer)
})

test('a media type key and a $ref string are cleaned on their way into evidence', () => {
  const media = report.findings.find((entry) => entry.ruleId === 'media-type-unsupported')
  assert.equal(media.evidence, 'application/json')
  const reference = report.findings.find((entry) => entry.ruleId === 'ref-remote-refused')
  assert.equal(reference.evidence, 'https://example.invalid/a b.json')
})

/**
 * Sanitising is lossy, and a finding is not lost with it.
 *
 * Two property names that differ only in a bidi control are two positions in
 * the example and one string in the report. Deduplicating on what a reader sees
 * would delete one of them and understate the error count, so the key is built
 * from the position the document really named, before anything is stripped.
 */
test('two positions that differ only in a stripped character are both reported', async () => {
  const path = join(workspace, 'lookalike.json')
  await writeFile(path, JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Lookalikes', version: '1' },
    paths: {
      '/a': {
        get: {
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: false },
                  example: { dup: 1, [`dup${RLM}`]: 2 },
                },
              },
            },
          },
        },
      },
    },
  }))
  const result = await execFileAsync(process.execPath, [cli, '--spec', path, '--json'], { cwd: projectDirectory })
    .then((value) => value, (error) => error)
  const lookalike = JSON.parse(result.stdout)
  const extras = lookalike.findings.filter((finding) => finding.ruleId === 'example-additional-property')
  assert.equal(extras.length, 2, 'one of the two offending properties was dropped as a duplicate')
  assert.equal(lookalike.summary.errors, 2)
  assert.deepEqual(new Set(extras.map((finding) => finding.location.pointer)).size, 1, 'they are meant to be indistinguishable to a reader')
  assert.equal(extras[0].location.pointer.endsWith('/example/dup'), true, extras[0].location.pointer)
  for (const finding of extras) assert.equal(finding.message.includes(RLM), false)
})

test('a format name carrying an isolate is cleaned before it reaches the message', () => {
  const finding = report.findings.find((entry) => entry.ruleId === 'format-not-asserted')
  assert.equal(finding.message.includes('"emai l"'), true, finding.message)
  assert.equal(finding.evidence, 'emai l')
})

/**
 * The parse-failure path, which every case above walks past.
 *
 * Everything above rides inside a document the tool parsed and then chose to
 * describe. A description that does not parse never reaches that code: it is
 * described by V8's own error message instead, and V8 phrases one of its two
 * parse failures as `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid
 * JSON` -- reproducing a short file in full, into the `document-not-json`
 * evidence field, on stdout.
 *
 * `sanitize` cannot repair it: it strips control characters and cuts from the
 * end, and the quoted snippet is at the front.
 *
 * An OpenAPI description carries example payloads, so it carries exactly the
 * kind of thing that must not be echoed. The canaries are published
 * placeholders, never real credentials: the example key id from the AWS
 * documentation, the standard test card number that authorises nothing (with a
 * leading letter, because the bare digits are a valid JSON number), and a host
 * under the RFC 2606 `.invalid` reserved top-level domain. Every prefix from
 * eight characters up is scanned on both streams -- a check of the whole value
 * alone passes for output that leaks all but the last character.
 */
const CANARIES = Object.freeze({
  'AWS example access key id': 'AKIAIOSFODNN7EXAMPLE',
  'standard test card number': 'x4111111111111111',
  'reserved example host': 'api.example.invalid',
  'bearer-looking token': 'Bearer-ZXhhbXBsZS10b2tlbg',
})

const MIN_PREFIX = 8

test('a description that will not parse is not quoted back by its own parse error', async () => {
  const path = join(workspace, 'unparseable.json')
  for (const [name, canary] of Object.entries(CANARIES)) {
    await writeFile(path, canary)
    const run = (args) => execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
      .then((value) => value, (error) => error)
    const machineRun = await run(['--spec', path, '--json'])
    const humanRun = await run(['--spec', path])

    const parsed = JSON.parse(machineRun.stdout)
    assert.equal(
      parsed.findings.some((finding) => finding.ruleId === 'document-not-json'),
      true,
      'the document must really have failed to parse',
    )

    for (let length = MIN_PREFIX; length <= canary.length; length += 1) {
      const prefix = canary.slice(0, length)
      for (const [stream, text] of [
        ['stdout', machineRun.stdout],
        ['stderr', machineRun.stderr],
        ['human stdout', humanRun.stdout],
        ['human stderr', humanRun.stderr],
      ]) {
        assert.equal(text.includes(prefix), false, `${name}: "${prefix}" reached ${stream}`)
      }
    }
  }
})

/**
 * The other half of the fix: a diagnostic that says nothing is a different
 * defect. A description missing one comma reports a position, a line and a
 * column rather than a quotation, and that is what a reader needs.
 */
test('a parse failure still says where the description went wrong', async () => {
  const path = join(workspace, 'missing-comma.json')
  await writeFile(path, '{\n  "openapi": "3.1.0"\n  "paths": {}\n}\n')
  const result = await execFileAsync(process.execPath, [cli, '--spec', path, '--json'], { cwd: projectDirectory })
    .then((value) => value, (error) => error)

  const finding = JSON.parse(result.stdout).findings.find((entry) => entry.ruleId === 'document-not-json')
  assert.notEqual(finding, undefined)
  assert.match(finding.evidence, /position \d+/)
  assert.match(finding.evidence, /line \d+ column \d+/)
})
