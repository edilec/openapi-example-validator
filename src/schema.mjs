/**
 * The bounded schema validator.
 *
 * This is a purpose-built subset, not a JSON Schema implementation, and the
 * difference is declared rather than disclaimed. Every keyword is in exactly
 * one of three sets:
 *
 * - **asserted** -- modelled here, and a violation is a finding;
 * - **annotation** -- carries no constraint, so ignoring it is what the
 *   specification says to do;
 * - **everything else** -- reported as `schema-keyword-unsupported`, which
 *   makes the run `incomplete`.
 *
 * The third set is the honest part. A validator that walks past `oneOf` it
 * cannot evaluate and then reports `pass` has not validated the example; it has
 * declared victory. Here an example under a schema this tool does not fully
 * model can still *fail* -- the constraints that were evaluated are real, and
 * JSON Schema is conjunctive, so no unevaluated keyword can rescue a value that
 * already violated an evaluated one -- but it can never *pass*.
 */

import { isRecord } from './document.mjs'
import { measureDepth, pointerOf } from './pointer.mjs'
import { renderValue, sanitize } from './text.mjs'

/** The 2020-12 dialect, which is the only `$schema` value OpenAPI 3.1 may declare here. */
export const SUPPORTED_DIALECTS = Object.freeze([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

/** Keywords whose violation is a finding, per OpenAPI minor version. */
const ASSERTED = Object.freeze({
  '3.0': Object.freeze([
    '$ref', 'type', 'nullable', 'enum', 'format', 'multipleOf', 'maximum', 'exclusiveMaximum',
    'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'items', 'maxItems',
    'minItems', 'uniqueItems', 'required', 'properties', 'additionalProperties', 'maxProperties',
    'minProperties', 'allOf', 'anyOf', 'oneOf',
  ]),
  '3.1': Object.freeze([
    '$ref', '$schema', 'type', 'enum', 'const', 'format', 'multipleOf', 'maximum',
    'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
    'items', 'maxItems', 'minItems', 'uniqueItems', 'required', 'properties',
    'additionalProperties', 'maxProperties', 'minProperties', 'allOf', 'anyOf', 'oneOf',
  ]),
})

/**
 * Keywords that constrain nothing.
 *
 * `example`, `examples` and `default` are documentation; `$defs` and
 * `definitions` are containers whose contents are checked when something
 * references them and are not constraints in themselves; `discriminator` only
 * selects which `oneOf` branch a reader should try first, and every branch is
 * tried here anyway.
 */
const ANNOTATIONS = Object.freeze([
  'title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly',
  'writeOnly', 'externalDocs', 'xml', 'discriminator', '$comment', '$defs', 'definitions',
])

/** The three formats asserted. Every other `format` is reported as not asserted. */
export const ASSERTED_FORMATS = Object.freeze(['date', 'date-time', 'uuid'])

const TYPE_NAMES = Object.freeze({
  '3.0': Object.freeze(['boolean', 'object', 'array', 'number', 'integer', 'string']),
  '3.1': Object.freeze(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']),
})

const KNOWN = Object.freeze({
  '3.0': new Set([...ASSERTED['3.0'], ...ANNOTATIONS, '$schema']),
  '3.1': new Set([...ASSERTED['3.1'], ...ANNOTATIONS]),
})

export function keywordsFor(dialect) {
  return { asserted: [...ASSERTED[dialect]], annotations: [...ANNOTATIONS] }
}

/** The JSON type of a parsed value. `integer` is decided against a schema, not here. */
export function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value, name) {
  if (name === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (name === 'number') return typeof value === 'number'
  return typeOf(value) === name
}

/**
 * Structural equality over parsed JSON, used by `enum`, `const` and
 * `uniqueItems`. Object key order is not significant, which is why this is not
 * a `JSON.stringify` comparison.
 */
export function deepEqual(left, right, state) {
  if (!spend(state, 1)) return false
  if (left === right) return true
  const kind = typeOf(left)
  if (kind !== typeOf(right)) return false
  if (kind === 'array') {
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index], state))
  }
  if (kind === 'object') {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key], state))
  }
  return false
}

/** Days in a month, computed rather than looked up in a `Date`. */
function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const [, year, month, day] = match.map(Number)
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/**
 * RFC 3339 date-time, checked without constructing a `Date`.
 *
 * `new Date('2024-02-30T00:00:00Z')` does not throw, it rolls over to March,
 * so a date check written on top of it silently accepts a day that does not
 * exist. The fields are range-checked here instead. A leap second (`:60`) is
 * accepted because RFC 3339 permits it.
 */
export function isDateTime(text) {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(text)
  if (match === null) return false
  if (!isCalendarDate(match[1])) return false
  const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4])]
  if (hour > 23 || minute > 59 || second > 60) return false
  if (match[5] !== undefined && (Number(match[5]) > 23 || Number(match[6]) > 59)) return false
  return true
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function checkFormat(name, text) {
  if (name === 'date') return isCalendarDate(text)
  if (name === 'date-time') return isDateTime(text)
  if (name === 'uuid') return UUID.test(text)
  return true
}

/**
 * Refuse a pattern whose matching cost this tool cannot bound.
 *
 * A `pattern` comes out of an untrusted document and is compiled into a real
 * regular expression, so a document could otherwise hand the validator
 * `(a+)+$` and watch it backtrack for the rest of the afternoon. A quantifier
 * applied to a group that itself contains a quantifier or an alternation is the
 * shape every catastrophic case has, so that shape is refused as unsupported --
 * reported, and the run marked incomplete, never quietly skipped.
 *
 * This is deliberately conservative: `^(a|b)+$` is refused although it is
 * harmless, because distinguishing it from `^(a|a)+$` means solving the
 * ambiguity question the refusal exists to avoid.
 */
export function hasUnboundedNesting(source) {
  const stack = [{ risky: false }]
  let index = 0
  const top = () => stack[stack.length - 1]
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '[') {
      index += 1
      while (index < source.length && source[index] !== ']') {
        index += source[index] === '\\' ? 2 : 1
      }
      index += 1
      continue
    }
    if (character === '(') {
      stack.push({ risky: false })
      index += 1
      if (source[index] === '?') {
        const prefix = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(source.slice(index))
        index += prefix === null ? 1 : prefix[0].length
      }
      continue
    }
    if (character === ')') {
      const frame = stack.length > 1 ? stack.pop() : { risky: top().risky }
      const quantifier = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(source.slice(index + 1))
      if (quantifier !== null && frame.risky) return true
      if (quantifier !== null) top().risky = true
      else if (frame.risky) top().risky = true
      index += 1 + (quantifier === null ? 0 : quantifier[0].length)
      continue
    }
    if (character === '|' || character === '*' || character === '+' || character === '?' || character === '{') {
      top().risky = true
      index += 1
      continue
    }
    index += 1
  }
  return false
}

/* -------------------------------------------------------------------------- */

function spend(state, cost) {
  if (state.halted) return false
  state.budget -= cost
  if (state.budget < 0) {
    halt(state, 'node-budget-exceeded', `Analysis passed the maxNodes limit of ${state.limits.maxNodes}, so this example was not fully checked.`)
    return false
  }
  if (state.deadline.exceeded()) {
    halt(state, 'time-budget-exceeded', `Analysis passed the maxMillis budget of ${state.limits.maxMillis}, so this example was not fully checked.`)
    return false
  }
  return true
}

function halt(state, ruleId, message) {
  state.halted = true
  state.haltProblem = {
    kind: 'structural',
    ruleId,
    parts: state.exampleParts,
    message,
    suggestion: 'Raise the limit deliberately, or reduce the size of the description.',
  }
}

/** Where inside the example a finding sits, written for a person to read. */
function at(path) {
  const pointer = pointerOf(path)
  return pointer === '' ? 'the example itself' : `the example position ${pointer}`
}

function valueProblem(state, ruleId, path, message, evidence) {
  return { kind: 'value', ruleId, parts: [...state.exampleParts, ...path], message, evidence }
}

function schemaProblem(ruleId, parts, message, evidence, suggestion) {
  return { kind: 'structural', ruleId, parts, message, evidence, suggestion }
}

/**
 * Validate one example value against one schema.
 *
 * Returns a flat list of problems. Each is tagged: `structural` problems are
 * gaps in the evidence and always reach the report; `value` problems are
 * failures of the example itself and are discarded inside an `anyOf` or
 * `oneOf` branch that did not win; `note` problems are observations that change
 * no verdict.
 */
export function validateExample(value, schema, options) {
  const state = {
    dialect: options.dialect,
    limits: options.limits,
    resolver: options.resolver,
    deadline: options.deadline,
    budget: options.budget,
    patterns: options.patterns,
    exampleParts: options.exampleParts,
    active: new Set(),
    halted: false,
    haltProblem: null,
  }
  const found = check(value, schema, options.schemaParts, [], 0, state)
  /**
   * A halted run stops mid-evaluation, so a value problem it had reached may
   * rest on a comparison that was cut short. Gaps in the evidence still reach
   * the report -- they are what makes the run incomplete -- but an accusation
   * against the example does not, because the tool no longer knows it is true.
   */
  const problems = state.halted ? found.filter((problem) => problem.kind !== 'value') : found
  if (state.halted && state.haltProblem !== null) problems.push(state.haltProblem)
  return { problems, budget: state.budget, halted: state.halted }
}

function check(value, schema, schemaParts, path, depth, state) {
  if (!spend(state, 1)) return []
  if (depth > state.limits.maxEvalDepth) {
    return [schemaProblem(
      'schema-too-deep',
      schemaParts,
      `Evaluating this schema passed the maxEvalDepth limit of ${state.limits.maxEvalDepth}, so ${at(path)} was not checked.`,
      undefined,
      'Raise --max-eval-depth deliberately, or flatten the schema.',
    )]
  }

  const resolved = state.resolver.resolve(schema, schemaParts)
  if (!resolved.ok) {
    return [schemaProblem(
      resolved.ruleId,
      schemaParts,
      `${resolved.message} So ${at(path)} was not checked.`,
      resolved.evidence,
      'Declare the schema in this document, or check the example by hand.',
    )]
  }
  if (resolved.hops > 0 && !spend(state, resolved.hops)) return []

  const node = resolved.value
  const parts = resolved.parts
  const pointer = pointerOf(parts)

  if (!isRecord(node)) {
    return [schemaProblem(
      'schema-malformed',
      parts,
      typeof node === 'boolean'
        ? `This schema is the boolean ${node}, which this tool does not model, so ${at(path)} was not checked.`
        : `This schema is not an object, so ${at(path)} was not checked.`,
      renderValue(node, 60),
      'Declare an object schema.',
    )]
  }

  /**
   * The same schema against the same position twice means a reference cycle
   * that consumes no value -- `A.allOf[0] -> B`, `B.allOf[0] -> A`. The
   * resolver catches a bare `$ref` loop on its own; this catches the ones that
   * travel through a keyword, and it is what makes a genuinely self-referencing
   * schema safe to validate: a recursive `Node` shrinks the value at every hop,
   * so the pair is never repeated.
   */
  const signature = JSON.stringify([pointer, pointerOf(path)])
  if (state.active.has(signature)) {
    return [schemaProblem(
      'ref-cycle',
      parts,
      `This schema refers back to itself without consuming any of the example, so ${at(path)} was not checked.`,
      pointer,
      'Break the cycle, or give the recursive position a concrete schema.',
    )]
  }
  state.active.add(signature)
  const problems = collect(value, node, parts, path, depth, state)
  state.active.delete(signature)
  return problems
}

function collect(value, node, parts, path, depth, state) {
  const problems = []
  const push = (problem) => problems.push(problem)
  const bad = (message, evidence, keyword) => push(schemaProblem(
    'schema-malformed',
    keyword === undefined ? parts : [...parts, keyword],
    `${message} So ${at(path)} was not checked against it.`,
    evidence,
    'Correct the schema.',
  ))

  if (Object.hasOwn(node, '$schema')) {
    const declared = node.$schema
    if (state.dialect === '3.0') {
      push(schemaProblem(
        'schema-dialect-unsupported',
        [...parts, '$schema'],
        'An OpenAPI 3.0 Schema Object may not declare a dialect, so this schema was not evaluated.',
        typeof declared === 'string' ? declared : typeof declared,
        'Remove "$schema", or describe the API with OpenAPI 3.1.',
      ))
    } else if (typeof declared !== 'string' || !SUPPORTED_DIALECTS.includes(declared)) {
      push(schemaProblem(
        'schema-dialect-unsupported',
        [...parts, '$schema'],
        `This tool models the ${SUPPORTED_DIALECTS[0]} dialect only, so this schema was not evaluated.`,
        typeof declared === 'string' ? declared : typeof declared,
        'Declare the 2020-12 dialect, or check the example by hand.',
      ))
    }
  }

  const known = KNOWN[state.dialect]
  for (const keyword of Object.keys(node)) {
    if (known.has(keyword)) continue
    push(schemaProblem(
      'schema-keyword-unsupported',
      [...parts, keyword],
      `This tool does not model the keyword "${sanitize(keyword, 60)}", so it cannot report ${at(path)} as valid.`,
      keyword,
      'Remove the keyword, or treat this example as unchecked.',
    ))
  }

  /* -- type ------------------------------------------------------------- */
  let nullable = false
  if (state.dialect === '3.0' && Object.hasOwn(node, 'nullable')) {
    if (typeof node.nullable !== 'boolean') bad('"nullable" must be a boolean.', renderValue(node.nullable, 60), 'nullable')
    else nullable = node.nullable
  }
  if (Object.hasOwn(node, 'type')) {
    const declared = Array.isArray(node.type) ? node.type : [node.type]
    if (Array.isArray(node.type) && state.dialect === '3.0') {
      push(schemaProblem(
        'schema-type-invalid',
        [...parts, 'type'],
        `An OpenAPI 3.0 schema declares one type, not a list, so ${at(path)} was not checked against it.`,
        renderValue(node.type, 60),
        'Declare a single type, with "nullable": true if the value may be null.',
      ))
    } else if (declared.length === 0 || declared.some((name) => !TYPE_NAMES[state.dialect].includes(name))) {
      push(schemaProblem(
        'schema-type-invalid',
        [...parts, 'type'],
        `This schema declares a type this tool does not recognise, so ${at(path)} was not checked against it.`,
        renderValue(node.type, 60),
        `Declare one of: ${TYPE_NAMES[state.dialect].join(', ')}.`,
      ))
    } else if (!declared.some((name) => matchesType(value, name)) && !(nullable && value === null)) {
      push(valueProblem(
        state,
        'example-type-mismatch',
        path,
        `The example at ${pointerOf(path) || '/'} is ${typeOf(value)}, but the schema declares ${declared.join(' or ')}.`,
        renderValue(value, 80),
      ))
      return problems
    }
  }

  /* -- enum and const --------------------------------------------------- */
  if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) bad('"enum" must be a non-empty array.', renderValue(node.enum, 60), 'enum')
    else if (!node.enum.some((candidate) => deepEqual(value, candidate, state))) {
      push(valueProblem(
        state,
        'example-enum-mismatch',
        path,
        `The example at ${pointerOf(path) || '/'} is not one of the ${node.enum.length} value(s) the schema enumerates.`,
        renderValue(value, 80),
      ))
    }
  }
  if (state.dialect === '3.1' && Object.hasOwn(node, 'const') && !deepEqual(value, node.const, state)) {
    push(valueProblem(
      state,
      'example-const-mismatch',
      path,
      `The example at ${pointerOf(path) || '/'} is not the single value the schema declares as "const".`,
      renderValue(value, 80),
    ))
  }

  /* -- numbers ----------------------------------------------------------- */
  if (typeof value === 'number') numberChecks(value, node, parts, path, state, push, bad)

  /* -- strings ----------------------------------------------------------- */
  if (typeof value === 'string') stringChecks(value, node, parts, path, state, push, bad)

  /* -- arrays ------------------------------------------------------------ */
  if (Array.isArray(value)) {
    boundChecks(value.length, 'minItems', 'maxItems', 'item(s)', node, parts, path, state, push, bad)
    if (Object.hasOwn(node, 'uniqueItems')) {
      if (typeof node.uniqueItems !== 'boolean') bad('"uniqueItems" must be a boolean.', renderValue(node.uniqueItems, 60), 'uniqueItems')
      else if (node.uniqueItems) {
        for (let index = 1; index < value.length && !state.halted; index += 1) {
          for (let earlier = 0; earlier < index; earlier += 1) {
            if (!deepEqual(value[index], value[earlier], state)) continue
            push(valueProblem(
              state,
              'example-duplicate-items',
              [...path, String(index)],
              `The example at ${pointerOf([...path, String(index)])} repeats the item at index ${earlier}, but the schema declares "uniqueItems".`,
              renderValue(value[index], 80),
            ))
            break
          }
        }
      }
    }
    if (Object.hasOwn(node, 'items')) {
      for (let index = 0; index < value.length && !state.halted; index += 1) {
        for (const problem of check(value[index], node.items, [...parts, 'items'], [...path, String(index)], depth + 1, state)) push(problem)
      }
    }
  }

  /* -- objects ----------------------------------------------------------- */
  if (isRecord(value)) objectChecks(value, node, parts, path, depth, state, push, bad)

  /* -- combinators -------------------------------------------------------- */
  for (const problem of combinatorChecks(value, node, parts, path, depth, state)) push(problem)

  return problems
}

function numberChecks(value, node, parts, path, state, push, bad) {
  const here = pointerOf(path) || '/'
  const numeric = (keyword) => {
    if (!Object.hasOwn(node, keyword)) return null
    if (typeof node[keyword] !== 'number' || !Number.isFinite(node[keyword])) {
      bad(`"${keyword}" must be a finite number.`, renderValue(node[keyword], 60), keyword)
      return null
    }
    return node[keyword]
  }

  const multipleOf = numeric('multipleOf')
  if (multipleOf !== null) {
    if (multipleOf <= 0) bad('"multipleOf" must be greater than zero.', renderValue(node.multipleOf, 60), 'multipleOf')
    else if (!isMultipleOf(value, multipleOf)) {
      push(valueProblem(state, 'example-out-of-range', path, `The example at ${here} is ${value}, which is not a multiple of ${multipleOf}.`, renderValue(value, 40)))
    }
  }

  for (const [keyword, worse, describe] of [
    ['minimum', (a, b) => a < b, (bound) => `below the minimum ${bound}`],
    ['maximum', (a, b) => a > b, (bound) => `above the maximum ${bound}`],
  ]) {
    const bound = numeric(keyword)
    if (bound === null) continue
    if (worse(value, bound)) {
      push(valueProblem(state, 'example-out-of-range', path, `The example at ${here} is ${value}, ${describe(bound)}.`, renderValue(value, 40)))
    }
  }

  for (const [keyword, companion, worse, describe] of [
    ['exclusiveMinimum', 'minimum', (a, b) => a <= b, (bound) => `not above the exclusive minimum ${bound}`],
    ['exclusiveMaximum', 'maximum', (a, b) => a >= b, (bound) => `not below the exclusive maximum ${bound}`],
  ]) {
    if (!Object.hasOwn(node, keyword)) continue
    const declared = node[keyword]
    if (state.dialect === '3.0') {
      if (typeof declared !== 'boolean') {
        bad(`In OpenAPI 3.0 "${keyword}" is a boolean modifier on "${companion}".`, renderValue(declared, 60), keyword)
        continue
      }
      if (!declared) continue
      if (typeof node[companion] !== 'number') {
        bad(`"${keyword}": true requires a numeric "${companion}".`, renderValue(node[companion], 60), keyword)
        continue
      }
      if (worse(value, node[companion])) {
        push(valueProblem(state, 'example-out-of-range', path, `The example at ${here} is ${value}, ${describe(node[companion])}.`, renderValue(value, 40)))
      }
      continue
    }
    if (typeof declared !== 'number' || !Number.isFinite(declared)) {
      bad(`In OpenAPI 3.1 "${keyword}" is a number, not a modifier.`, renderValue(declared, 60), keyword)
      continue
    }
    if (worse(value, declared)) {
      push(valueProblem(state, 'example-out-of-range', path, `The example at ${here} is ${value}, ${describe(declared)}.`, renderValue(value, 40)))
    }
  }
}

/**
 * `multipleOf` without trusting binary floating point.
 *
 * `0.3 % 0.1` is 0.09999999999999998, so a plain modulo reports a violation
 * that is not there. Integers are compared exactly; everything else is compared
 * against the nearest integer ratio within a declared tolerance, which is
 * documented as a limit rather than left as a surprise.
 */
export const MULTIPLE_OF_TOLERANCE = 1e-9

export function isMultipleOf(value, divisor) {
  if (Number.isInteger(value) && Number.isInteger(divisor)) return value % divisor === 0
  const ratio = value / divisor
  if (!Number.isFinite(ratio)) return false
  return Math.abs(ratio - Math.round(ratio)) <= MULTIPLE_OF_TOLERANCE * Math.max(1, Math.abs(ratio))
}

function stringChecks(value, node, parts, path, state, push, bad) {
  const here = pointerOf(path) || '/'
  const characters = [...value].length
  boundChecks(characters, 'minLength', 'maxLength', 'character(s)', node, parts, path, state, push, bad)

  if (Object.hasOwn(node, 'pattern')) {
    const compiled = compilePattern(node.pattern, state)
    if (compiled.ok === false) {
      push(schemaProblem(
        compiled.ruleId,
        [...parts, 'pattern'],
        `${compiled.message} So ${at(path)} was not checked against it.`,
        typeof node.pattern === 'string' ? node.pattern : typeof node.pattern,
        compiled.suggestion,
      ))
    } else if (!compiled.expression.test(value)) {
      push(valueProblem(state, 'example-pattern-mismatch', path, `The example at ${here} does not match the declared pattern.`, renderValue(value, 80)))
    }
  }

  if (Object.hasOwn(node, 'format')) {
    if (typeof node.format !== 'string') bad('"format" must be a string.', renderValue(node.format, 60), 'format')
    else if (!ASSERTED_FORMATS.includes(node.format)) {
      push({
        kind: 'note',
        ruleId: 'format-not-asserted',
        parts: [...parts, 'format'],
        message: `The format "${sanitize(node.format, 60)}" is an annotation this tool does not assert, so no example was checked against it.`,
        evidence: node.format,
        suggestion: `Formats asserted here: ${ASSERTED_FORMATS.join(', ')}.`,
      })
    } else if (!checkFormat(node.format, value)) {
      push(valueProblem(state, 'example-format-invalid', path, `The example at ${here} is not a valid "${sanitize(node.format, 60)}".`, renderValue(value, 80)))
    }
  }
}

function compilePattern(source, state) {
  if (typeof source !== 'string') {
    return { ok: false, ruleId: 'schema-malformed', message: 'A "pattern" must be a string.', suggestion: 'Declare the pattern as a string.' }
  }
  const cached = state.patterns.get(source)
  if (cached !== undefined) return cached
  let result
  if (source.length > state.limits.maxPatternLength) {
    result = {
      ok: false,
      ruleId: 'schema-pattern-unsupported',
      message: `This pattern is longer than the maxPatternLength limit of ${state.limits.maxPatternLength}, so it was not compiled.`,
      suggestion: 'Raise --max-pattern-length deliberately, or simplify the pattern.',
    }
  } else {
    let expression = null
    try {
      expression = new RegExp(source, 'u')
    } catch {
      expression = null
    }
    if (expression === null) {
      result = {
        ok: false,
        ruleId: 'schema-pattern-invalid',
        message: 'This pattern is not a valid Unicode-mode regular expression, so it was not compiled.',
        suggestion: 'Correct the pattern, escaping any literal "{", "}" or "\\".',
      }
    } else if (hasUnboundedNesting(source)) {
      result = {
        ok: false,
        ruleId: 'schema-pattern-unsupported',
        message: 'This pattern quantifies a group that itself contains a quantifier or an alternation, a shape whose matching cost this tool will not bound, so it was not applied.',
        suggestion: 'Rewrite the pattern without a quantified group of alternatives.',
      }
    } else {
      result = { ok: true, expression }
    }
  }
  state.patterns.set(source, result)
  return result
}

function boundChecks(size, minimumKeyword, maximumKeyword, unit, node, parts, path, state, push, bad) {
  const here = pointerOf(path) || '/'
  for (const [keyword, worse, describe] of [
    [minimumKeyword, (a, b) => a < b, (bound) => `under ${minimumKeyword} ${bound}`],
    [maximumKeyword, (a, b) => a > b, (bound) => `over ${maximumKeyword} ${bound}`],
  ]) {
    if (!Object.hasOwn(node, keyword)) continue
    const bound = node[keyword]
    if (!Number.isInteger(bound) || bound < 0) {
      bad(`"${keyword}" must be a non-negative integer.`, renderValue(bound, 60), keyword)
      continue
    }
    if (worse(size, bound)) {
      push(valueProblem(state, 'example-length-invalid', path, `The example at ${here} has ${size} ${unit}, ${describe(bound)}.`, undefined))
    }
  }
}

function objectChecks(value, node, parts, path, depth, state, push, bad) {
  const here = pointerOf(path) || '/'
  const keys = Object.keys(value)
  boundChecks(keys.length, 'minProperties', 'maxProperties', 'propert(ies)', node, parts, path, state, push, bad)

  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
      bad('"required" must be an array of property names.', renderValue(node.required, 60), 'required')
    } else {
      for (const name of node.required) {
        if (Object.hasOwn(value, name)) continue
        push(valueProblem(
          state,
          'example-required-missing',
          [...path, name],
          `The example at ${here} does not declare the required property "${sanitize(name, 60)}".`,
          undefined,
        ))
      }
    }
  }

  let properties = null
  if (Object.hasOwn(node, 'properties')) {
    if (!isRecord(node.properties)) bad('"properties" must be an object.', renderValue(node.properties, 60), 'properties')
    else properties = node.properties
  }

  if (properties !== null) {
    for (const key of keys) {
      if (state.halted) break
      if (!Object.hasOwn(properties, key)) continue
      for (const problem of check(value[key], properties[key], [...parts, 'properties', key], [...path, key], depth + 1, state)) push(problem)
    }
  }

  if (Object.hasOwn(node, 'additionalProperties')) {
    const declared = node.additionalProperties
    const extra = keys.filter((key) => properties === null || !Object.hasOwn(properties, key))
    if (declared === false) {
      for (const key of extra) {
        push(valueProblem(
          state,
          'example-additional-property',
          [...path, key],
          `The example at ${here} declares "${sanitize(key, 60)}", which the schema does not declare and "additionalProperties": false forbids.`,
          undefined,
        ))
      }
    } else if (declared !== true) {
      if (!isRecord(declared)) bad('"additionalProperties" must be a boolean or a schema.', renderValue(declared, 60), 'additionalProperties')
      else {
        for (const key of extra) {
          if (state.halted) break
          for (const problem of check(value[key], declared, [...parts, 'additionalProperties'], [...path, key], depth + 1, state)) push(problem)
        }
      }
    }
  }
}

/**
 * `allOf`, `anyOf` and `oneOf`.
 *
 * `allOf` is a conjunction, so every branch's problems are real and all of them
 * are kept. The other two are disjunctions: a branch that failed says nothing
 * on its own, so a losing branch's value problems are discarded and only the
 * aggregate is reported.
 *
 * A branch that could not be evaluated -- an unsupported keyword, a refused
 * reference -- is different again. Its structural problem always surfaces, and
 * it also suppresses the aggregate: "none of these branches matched" would be
 * an accusation this tool has not earned when one of the branches was never
 * evaluated. The run is already `incomplete` by then, so nothing is lost.
 */
function combinatorChecks(value, node, parts, path, depth, state) {
  const problems = []
  const here = pointerOf(path) || '/'

  if (Object.hasOwn(node, 'allOf')) {
    const branches = branchesOf(node.allOf, 'allOf', parts, path, problems)
    for (let index = 0; index < branches.length && !state.halted; index += 1) {
      for (const problem of check(value, branches[index], [...parts, 'allOf', String(index)], path, depth + 1, state)) problems.push(problem)
    }
  }

  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Object.hasOwn(node, keyword)) continue
    const branches = branchesOf(node[keyword], keyword, parts, path, problems)
    let matched = 0
    const matchedIndexes = []
    let unevaluated = false
    for (let index = 0; index < branches.length && !state.halted; index += 1) {
      const found = check(value, branches[index], [...parts, keyword, String(index)], path, depth + 1, state)
      let failed = false
      for (const problem of found) {
        if (problem.kind === 'structural') {
          problems.push(problem)
          unevaluated = true
        } else if (problem.kind === 'note') {
          problems.push(problem)
        } else {
          failed = true
        }
      }
      if (!failed) {
        matched += 1
        matchedIndexes.push(index)
      }
    }
    if (state.halted || branches.length === 0 || unevaluated) continue
    if (keyword === 'anyOf' && matched === 0) {
      problems.push(valueProblem(state, 'example-any-of-unsatisfied', path, `The example at ${here} satisfies none of the ${branches.length} "anyOf" branches.`, renderValue(value, 80)))
    }
    if (keyword === 'oneOf' && matched === 0) {
      problems.push(valueProblem(state, 'example-one-of-unsatisfied', path, `The example at ${here} satisfies none of the ${branches.length} "oneOf" branches.`, renderValue(value, 80)))
    }
    if (keyword === 'oneOf' && matched > 1) {
      problems.push(valueProblem(
        state,
        'example-one-of-ambiguous',
        path,
        `The example at ${here} satisfies ${matched} of the ${branches.length} "oneOf" branches (${matchedIndexes.join(', ')}), and "oneOf" admits exactly one.`,
        renderValue(value, 80),
      ))
    }
  }

  return problems
}

function branchesOf(declared, keyword, parts, path, problems) {
  if (Array.isArray(declared) && declared.length > 0) return declared
  problems.push(schemaProblem(
    'schema-malformed',
    [...parts, keyword],
    `"${keyword}" must be a non-empty array of schemas. So ${at(path)} was not checked against it.`,
    renderValue(declared, 60),
    'Correct the schema.',
  ))
  return []
}

/** The depth of an example value, so the limit is enforced before it is walked. */
export function exampleDepth(value, limit) {
  return measureDepth(value, limit)
}
