#!/usr/bin/env node

import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { formatReport, validateOpenApiFile } from '../src/index.mjs'

const HELP = `openapi-example-validator

Check every request and response example in an OpenAPI 3.0 or 3.1 description
against the schema that governs it -- the schema declared for that media type,
under that operation. Local references are followed; a remote one is refused,
not fetched. Nothing is executed and no file is written.

Usage:
  openapi-example-validator --spec FILE [--json] [limits]

Options:
  --spec FILE               OpenAPI description to check, as JSON (required)
  --json                    Emit the machine-readable report on stdout
  --max-bytes N             Maximum description size (default 2097152)
  --max-depth N             Maximum JSON nesting in the description (default 40)
  --max-nodes N             Traversal and evaluation budget (default 200000)
  --max-operations N        Maximum operations examined (default 500)
  --max-examples N          Maximum examples examined (default 2000)
  --max-example-bytes N     Maximum size of one example (default 65536)
  --max-example-depth N     Maximum nesting inside one example (default 24)
  --max-ref-depth N         Maximum "$ref" chain length (default 16)
  --max-eval-depth N        Maximum schema evaluation depth (default 512)
  --max-pattern-length N    Maximum "pattern" source length (default 200)
  --max-pattern-steps N     Estimated work ceiling for one "pattern" match
                            (default 20000000)
  --max-millis N            Time budget in milliseconds (default 5000)
  -h, --help                Show this help

Every option is accepted once: a repeated flag is a configuration error, not a
silent last-wins. An unknown option is refused rather than ignored, because a
typo that falls back to a default is a real failure reported as a green run.

A limit that is reached is reported by name and makes the run incomplete. What
exceeded it is refused whole -- a document-level limit refuses the document, an
example-level limit refuses that example. Nothing is truncated.

What this tool cannot conclude is reported, never assumed. A reference it could
not follow, a schema keyword it does not model, a media type whose encoding it
does not model, an example that lives in another file: each is a finding, and
each makes the run incomplete rather than letting an unchecked example pass.

Exit codes:
  0  every example that could be checked agreed with its schema
  1  at least one example contradicts the schema that governs it
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-nodes', 'maxNodes'],
  ['--max-operations', 'maxOperations'],
  ['--max-examples', 'maxExamples'],
  ['--max-example-bytes', 'maxExampleBytes'],
  ['--max-example-depth', 'maxExampleDepth'],
  ['--max-ref-depth', 'maxRefDepth'],
  ['--max-eval-depth', 'maxEvalDepth'],
  ['--max-pattern-length', 'maxPatternLength'],
  ['--max-pattern-steps', 'maxPatternSteps'],
  ['--max-millis', 'maxMillis'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { spec: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--spec a --spec b` checks a description nobody named, and
   * `--max-examples 10 --max-examples 100000` enforces a bound nobody asked
   * for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--spec') {
      once('--spec')
      options.spec = takeValue('--spec')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const floor = argument === '--max-millis' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.spec === null) throw new Error('--spec is required')
  return options
}

/**
 * The label a finding carries.
 *
 * `location.file` is never an absolute host path: a report is an artifact
 * people paste into issues and diff between machines. A description inside the
 * working directory is named relative to it, and anything else by its base name
 * alone.
 */
function sourceLabel(specPath) {
  const absolute = resolve(specPath)
  const fromHere = relative(process.cwd(), absolute)
  if (fromHere === '' || fromHere.startsWith('..') || isAbsolute(fromHere)) return absolute.split(/[\\/]/).pop()
  return fromHere.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let result
  try {
    result = await validateOpenApiFile(options.spec, {
      source: sourceLabel(options.spec),
      limits: options.limits,
      // The clock the documented time budget is measured with. Wiring it here
      // is the difference between a limit that is enforced and one that is
      // merely written down.
      clock: () => performance.now(),
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const { report } = result
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(result))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.examples} example(s) were checked and `
      + `${report.summary.unknown} question(s) went unanswered; this run is not a verdict.\n`,
    )
    return 2
  }
  process.stderr.write(
    `${report.summary.checked} example(s) checked across ${report.summary.operations} operation(s); status ${report.status}.\n`,
  )
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
