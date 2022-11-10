import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { REFUSAL_REASONS, analyzePattern, estimatePatternWork } from '../src/pattern.mjs'
import { analyzeOpenApi } from '../src/index.mjs'

/**
 * The bound on a `pattern`, measured rather than asserted.
 *
 * A regular expression cannot be interrupted: the engine does not yield, so a
 * deadline checked between operations never fires during one. That is not a
 * theory -- `^a*a*a*a*a*a*a*a*a*a*$` against thirty `a`s and a `b` ran this tool
 * for 6.8 seconds under a declared 100-millisecond budget, and two more
 * quantifiers had to be killed after sixty seconds. So the guard cannot be a
 * timeout, and a test of the guard cannot be an assertion about a flag: it has
 * to feed the pathological input in and fail if the call does not come back.
 *
 * Every timing assertion below allows far more than the work should take and far
 * less than the defect took. The point is the order of magnitude, which is the
 * only part that is machine-independent.
 */

const BUDGET_MS = 1000

function analyze(document, limits) {
  return analyzeOpenApi({ bytes: new TextEncoder().encode(JSON.stringify(document)), source: 'pattern.json', limits }).report
}

function documentFor(pattern, example) {
  return {
    openapi: '3.1.0',
    info: { title: 'Patterns', version: '1' },
    paths: {
      '/p': {
        get: {
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { type: 'string', pattern }, example } } },
          },
        },
      },
    },
  }
}

function timed(fn) {
  const started = performance.now()
  const value = fn()
  return { value, elapsed: performance.now() - started }
}

/* -- the subset ------------------------------------------------------------ */

test('the shapes whose matching cost this tool will not bound are refused by name', () => {
  const refused = {
    '^(a+)+$': 'quantified-group',
    '^(a|b)+$': 'quantified-group',
    '^(?:[a-z]+)*$': 'quantified-group',
    '^(?:)*$': 'quantified-group',
    '^a*a*$': 'competing-quantifiers',
    '^a*a*a*a*a*a*a*a*a*a*$': 'competing-quantifiers',
    '^\\d*\\d*$': 'competing-quantifiers',
    '^[a-z]*[a-z]*$': 'competing-quantifiers',
    '^a*b?a*$': 'competing-quantifiers',
    '^a*(?:a*)$': 'competing-quantifiers',
    '^(?:ab)*(?:ab)*$': 'competing-quantifiers',
    '^[^a-z]*[0-9]*$': 'competing-quantifiers',
    '^(?=.*[a-z]).{8,}$': 'lookaround',
    '^(?<=a)b+$': 'lookaround',
    '^(a)\\1$': 'backreference',
  }
  for (const [source, reason] of Object.entries(refused)) {
    assert.doesNotThrow(() => new RegExp(source, 'u'), `${source} is not even a valid pattern`)
    assert.deepEqual(analyzePattern(source), { ok: false, reason }, source)
  }
})

test('the patterns a description actually carries are still applied', () => {
  const accepted = [
    '^[a-zA-Z0-9_]+$',
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^\\d{3}-\\d{2}-\\d{4}$',
    '^#[0-9a-fA-F]{6}$',
    '^[a-z]+@[a-z]+\\.[a-z]{2,}$',
    '^(?:GET|POST|PUT)$',
    '^(?:abc)+$',
    '^[a-z]{2,8}$',
    '^[(+*]+$',
    '^\\S+\\s\\S+$',
    '^\\p{L}+$',
    '^.*x$',
    '^$',
  ]
  for (const source of accepted) {
    const analysis = analyzePattern(source)
    assert.equal(analysis.ok, true, `${source} was refused: ${analysis.reason}`)
    assert.equal(estimatePatternWork(analysis, 200) <= DEFAULT_LIMITS.maxPatternSteps, true, `${source} is unaffordable at 200 characters`)
  }
})

test('every reason the analysis can give has words for the finding to use', () => {
  const reasons = new Set()
  for (const source of ['^(a+)+$', '^a*a*$', '^(?=a)b$', '^(a)\\1$', '^a{2,1}$']) {
    const analysis = analyzePattern(source)
    if (analysis.ok === false) reasons.add(analysis.reason)
  }
  assert.deepEqual([...reasons].sort(), ['backreference', 'competing-quantifiers', 'lookaround', 'quantified-group', 'syntax'])
  for (const reason of reasons) assert.equal(typeof REFUSAL_REASONS[reason], 'string')
  assert.deepEqual([...reasons].sort(), Object.keys(REFUSAL_REASONS).sort())
})

/* -- the estimate ---------------------------------------------------------- */

test('the estimate is a function of the subject, and an anchor is what makes a long one affordable', () => {
  const unanchored = analyzePattern('[a-z]*1')
  const anchored = analyzePattern('^[a-z]*1$')
  assert.equal(unanchored.anchored, false)
  assert.equal(anchored.anchored, true)
  assert.equal(estimatePatternWork(unanchored, 100), 101 * 101)
  assert.equal(estimatePatternWork(anchored, 100), 101)
  assert.equal(estimatePatternWork(unanchored, 6000) > DEFAULT_LIMITS.maxPatternSteps, true)
  assert.equal(estimatePatternWork(anchored, 65000) <= DEFAULT_LIMITS.maxPatternSteps, true)
})

test('alternation branches and variable-length terms are counted into the estimate', () => {
  const alternatives = analyzePattern('^(?:a|b|c)x$')
  assert.equal(alternatives.paths, 3)
  assert.equal(estimatePatternWork(alternatives, 10), 3 * 11)
  const terms = analyzePattern('^a*b*c*$')
  assert.equal(terms.variable, 3)
  assert.equal(estimatePatternWork(terms, 10), 3 * 11)
})

/* -- the measured bound ---------------------------------------------------- */

test('the pathological pattern that ran for 6.8 seconds now returns at once, unchecked', () => {
  for (const stars of [10, 12, 20]) {
    const pattern = `^${'a*'.repeat(stars)}$`
    const example = `${'a'.repeat(30)}b`
    const { value: report, elapsed } = timed(() => analyze(documentFor(pattern, example), { maxMillis: 100 }))
    assert.equal(elapsed < BUDGET_MS, true, `${stars} quantifiers took ${elapsed.toFixed(0)}ms`)
    assert.equal(report.status, 'incomplete', `${stars} quantifiers`)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'schema-pattern-unsupported'), true)
    assert.equal(report.summary.checked, 0)
    assert.equal(report.summary.unknown > 0, true)
  }
})

test('a nested quantifier is refused the same way, and an example under it never passes', () => {
  const { value: report, elapsed } = timed(() => analyze(documentFor('^(a+)+$', `${'a'.repeat(40)}b`)))
  assert.equal(elapsed < BUDGET_MS, true, `it took ${elapsed.toFixed(0)}ms`)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
})

test('an unbounded subject is refused before the match, not during it', () => {
  // `[a-z]*1` is unambiguous and still quadratic unanchored: against 65,000
  // letters it takes two seconds. The estimate refuses it; the anchored form of
  // the same pattern is applied to the same subject and reports a real verdict.
  const subject = 'a'.repeat(65000)
  const refused = timed(() => analyze(documentFor('[a-z]*1', subject), { maxExampleBytes: 100000 }))
  assert.equal(refused.elapsed < BUDGET_MS, true, `it took ${refused.elapsed.toFixed(0)}ms`)
  assert.equal(refused.value.status, 'incomplete')
  assert.deepEqual(
    refused.value.findings.filter((finding) => finding.ruleId === 'schema-pattern-unsupported').length,
    1,
  )

  const applied = timed(() => analyze(documentFor('^[a-z]*1$', subject), { maxExampleBytes: 100000 }))
  assert.equal(applied.elapsed < BUDGET_MS, true, `it took ${applied.elapsed.toFixed(0)}ms`)
  assert.equal(applied.value.status, 'fail')
  assert.deepEqual(applied.value.findings.map((finding) => finding.ruleId), ['example-pattern-mismatch'])
})

test('the worst match the default ceiling admits still returns well inside the time budget', () => {
  // The shape that costs the most per estimated step: one quantifier that
  // swallows the whole subject, a pinned tail that never matches, and no anchor,
  // so the engine retries at every starting position. Its estimate is just under
  // the default limit, and it is the case the default is calibrated on.
  const length = Math.floor(Math.sqrt(DEFAULT_LIMITS.maxPatternSteps)) - 1
  const analysis = analyzePattern('[a-z]*1')
  assert.equal(estimatePatternWork(analysis, length) <= DEFAULT_LIMITS.maxPatternSteps, true)
  const { value: report, elapsed } = timed(() => analyze(documentFor('[a-z]*1', 'a'.repeat(length))))
  assert.equal(elapsed < BUDGET_MS, true, `the worst admitted match took ${elapsed.toFixed(0)}ms`)
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['example-pattern-mismatch'])
})

test('a refused pattern is a gap in the evidence, so the example is never reported as checked', () => {
  const report = analyze(documentFor('^(a+)+$', 'aaa'))
  const finding = report.findings.find((entry) => entry.ruleId === 'schema-pattern-unsupported')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer.endsWith('/schema/pattern'), true, finding.location.pointer)
  assert.equal(finding.evidence, '^(a+)+$')
  assert.equal(report.summary.examples, 1)
  assert.equal(report.summary.checked, 0)
})
