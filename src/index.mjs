/**
 * openapi-example-validator
 *
 * Reads one OpenAPI description, follows the local references it needs, and
 * checks every request and response example against the schema that actually
 * governs it -- the schema declared for *that* media type, under *that*
 * operation. Nothing is executed, nothing is fetched, and nothing is written.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **An unanswered question is never a pass.** A reference that could not be
 *    followed, a schema keyword this tool does not model, a media type it does
 *    not understand, a limit reached -- each makes the run `incomplete`.
 *    Incomplete is not a verdict in either direction; it says the evidence for
 *    one was not obtained. An example is only `checked` when a schema for it
 *    was actually found and applied.
 * 2. **Every finding names an exact position.** `location.pointer` is a JSON
 *    Pointer into the description, running through the operation, the media
 *    type, the example and then into the example value itself, so a failure
 *    five levels down inside a nested example is addressable rather than
 *    described.
 * 3. **The media type decides the schema.** Two examples under one operation
 *    are checked against two different schemas when they sit under two
 *    different media types, and a media type whose encoding this tool does not
 *    model is reported rather than validated as if it were JSON.
 * 4. **Everything from the description is untrusted.** Path templates, media
 *    types, example names, property names, `$ref` strings, formats and schema
 *    keywords are all strings the document's author chose, and every one of
 *    them is sanitised on its way to a pointer or a message.
 */

import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import { DEFAULT_LIMITS, detectVersion, isRecord, readDocument, validateLimits } from './document.mjs'
import { measureBytes, measureDepth, reportPointer } from './pointer.mjs'
import { createResolver } from './refs.mjs'
import { SUPPORTED_DIALECTS, validateExample } from './schema.mjs'
import { EXCERPT_LIMIT, LABEL_LIMIT, MESSAGE_LIMIT, byCodeUnit, sanitize } from './text.mjs'

export const TOOL_ID = 'openapi-example-validator'
export const REPORT_SCHEMA_VERSION = '1'

const DEFAULT_SOURCE = 'openapi.json'
const SEVERITY_WIDTH = 7

/** The operation keys of a Path Item Object, in a fixed order no input can change. */
export const METHODS = Object.freeze(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across construction sites as a literal it drifts silently, so
 * every finding takes its severity from here and an unknown rule id throws.
 *
 * This table is the source of truth; it is not the guard. Asserting it against
 * the documented catalog, and against a hand-written copy in a test, is three
 * declarations agreeing with each other, and one coordinated edit satisfies all
 * three. `test/severity-behaviour.test.mjs` shares nothing with any of them: it
 * drives each rule through the real command line and states the exit code, the
 * counts and the printed severity word as literals.
 *
 * The policy this encodes: an example that contradicts its schema is an error,
 * because that is the defect the tool exists to find. Anything this tool could
 * not evaluate is an error too, and additionally makes the run incomplete. The
 * three warnings are gaps that would otherwise read as silence, and the one
 * `info` rule records a keyword that constrains nothing.
 */
export const RULE_SEVERITY = Object.freeze({
  'document-malformed': 'error',
  'document-not-json': 'error',
  'document-not-utf8': 'error',
  'document-too-deep': 'error',
  'document-too-large': 'error',
  'document-unreadable': 'error',
  'example-additional-property': 'error',
  'example-any-of-unsatisfied': 'error',
  'example-const-mismatch': 'error',
  'example-declaration-conflict': 'error',
  'example-duplicate-items': 'error',
  'example-enum-mismatch': 'error',
  'example-external-value': 'warning',
  'example-format-invalid': 'error',
  'example-length-invalid': 'error',
  'example-not-text': 'error',
  'example-one-of-ambiguous': 'error',
  'example-one-of-unsatisfied': 'error',
  'example-out-of-range': 'error',
  'example-pattern-mismatch': 'error',
  'example-required-missing': 'error',
  'example-too-deep': 'error',
  'example-too-large': 'error',
  'example-type-mismatch': 'error',
  'format-not-asserted': 'info',
  'media-type-unsupported': 'error',
  'no-examples-declared': 'warning',
  'node-budget-exceeded': 'error',
  'openapi-version-missing': 'error',
  'openapi-version-unsupported': 'error',
  'operation-malformed': 'error',
  'ref-cycle': 'error',
  'ref-depth-exceeded': 'error',
  'ref-external-file-unsupported': 'error',
  'ref-malformed': 'error',
  'ref-remote-refused': 'error',
  'ref-unresolved': 'error',
  'schema-dialect-unsupported': 'error',
  'schema-keyword-unsupported': 'error',
  'schema-malformed': 'error',
  'schema-missing': 'warning',
  'schema-pattern-invalid': 'error',
  'schema-pattern-unsupported': 'error',
  'schema-too-deep': 'error',
  'schema-type-invalid': 'error',
  'time-budget-exceeded': 'error',
  'too-many-examples': 'error',
  'too-many-operations': 'error',
})

/**
 * The rules that mean a question could not be answered.
 *
 * Each marks the run `incomplete`, which is what keeps an unchecked example
 * from reporting a verdict. Three of them are `warning` severity --
 * `no-examples-declared`, `schema-missing` and `example-external-value` -- so
 * for those this membership is the *only* thing standing between the run and a
 * green build; `test/incompleteness.test.mjs` drives each one through the real
 * command line and fails the moment it is removed from this list.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'document-malformed',
  'document-not-json',
  'document-not-utf8',
  'document-too-deep',
  'document-too-large',
  'document-unreadable',
  'example-external-value',
  'example-too-deep',
  'example-too-large',
  'media-type-unsupported',
  'no-examples-declared',
  'node-budget-exceeded',
  'openapi-version-missing',
  'openapi-version-unsupported',
  'operation-malformed',
  'ref-cycle',
  'ref-depth-exceeded',
  'ref-external-file-unsupported',
  'ref-malformed',
  'ref-remote-refused',
  'ref-unresolved',
  'schema-dialect-unsupported',
  'schema-keyword-unsupported',
  'schema-malformed',
  'schema-missing',
  'schema-pattern-invalid',
  'schema-pattern-unsupported',
  'schema-too-deep',
  'schema-type-invalid',
  'time-budget-exceeded',
  'too-many-examples',
  'too-many-operations',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['bytes', 'clock', 'limits', 'source'])

function label(value, limit = LABEL_LIMIT) {
  return sanitize(value, limit)
}

/* -------------------------------------------------------------------------- */

function createCollector() {
  return { rows: [], seen: new Set(), incomplete: false }
}

/**
 * Add one finding.
 *
 * The severity comes from the table and nowhere else, and an id the table does
 * not know throws rather than defaulting -- a rule that quietly became a
 * warning is exactly the drift the table exists to prevent. The deduplication
 * key is the whole finding: one schema referenced by four examples would
 * otherwise report the same unsupported keyword, at the same pointer, in the
 * same words, four times.
 */
function record(collector, row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) throw new TypeError(`No severity is declared for rule "${row.ruleId}"`)
  const pointer = reportPointer(row.parts)
  const message = sanitize(row.message, MESSAGE_LIMIT)
  const evidence = row.evidence === undefined || row.evidence === null ? null : sanitize(row.evidence, EXCERPT_LIMIT)
  const key = JSON.stringify([row.ruleId, pointer, message, evidence])
  if (INCOMPLETE.has(row.ruleId)) collector.incomplete = true
  if (collector.seen.has(key)) return
  collector.seen.add(key)
  collector.rows.push({
    ruleId: row.ruleId,
    severity,
    message,
    pointer,
    evidence,
    suggestion: row.suggestion === undefined || row.suggestion === null ? null : sanitize(row.suggestion, MESSAGE_LIMIT),
    order: collector.rows.length,
  })
}

/**
 * The documented sort key: `(location.pointer, ruleId, declaration order)`.
 *
 * `location.file` is not part of it. Every finding in a run comes from the one
 * description, so sorting by it would compare a string with itself, and a sort
 * key that cannot discriminate is not a sort key. The message is not part of it
 * either: two findings alike in pointer and rule differ only in which keyword
 * of one schema they came from, and those are checked in a fixed order, so
 * declaration order already settles them without introducing a comparison no
 * input can reach.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.pointer, right.pointer)
    || byCodeUnit(left.ruleId, right.ruleId)
    || (left.order - right.order)
}

function createDeadline(clock, maxMillis) {
  const started = clock()
  if (typeof started !== 'number' || !Number.isFinite(started)) {
    throw new TypeError('clock must return a finite number of milliseconds')
  }
  return { exceeded: () => clock() - started >= maxMillis }
}

function defaultClock() {
  return performance.now()
}

/* -------------------------------------------------------------------------- */

/**
 * Classify a media type key.
 *
 * The essence decides how the example is read: a JSON media type carries a
 * structured value, `text/plain` carries a string. Anything else -- form
 * encoding, multipart, XML, `application/octet-stream`, a wildcard -- has a
 * serialisation this tool does not model, and an example under it is reported
 * as unchecked rather than validated as if it were JSON.
 */
export function classifyMediaType(raw) {
  const [essence, ...parameters] = String(raw).split(';')
  const trimmed = essence.trim().toLowerCase()
  const token = "[a-z0-9!#$%&'*+.^_`|~-]+"
  if (!new RegExp(`^${token}/${token}$`).test(trimmed)) return { kind: 'malformed' }
  for (const parameter of parameters) {
    const [name, ...rest] = parameter.split('=')
    if (name.trim().toLowerCase() !== 'charset') continue
    const charset = rest.join('=').trim().toLowerCase().replace(/^"|"$/g, '')
    if (charset !== 'utf-8' && charset !== 'utf8') return { kind: 'charset', charset }
  }
  if (trimmed === 'application/json' || /\+json$/.test(trimmed)) return { kind: 'json', essence: trimmed }
  if (trimmed === 'text/plain') return { kind: 'text', essence: trimmed }
  return { kind: 'unsupported', essence: trimmed }
}

/* -------------------------------------------------------------------------- */

/**
 * Analyse an OpenAPI description supplied as bytes.
 *
 * Configuration errors -- an unknown option, an unknown limit, a limit that is
 * not an integer -- throw. They mean the run never had a subject, so there is
 * nothing to report about, and the command line turns them into exit 2 with an
 * empty stdout. Everything that is a fact about the *document* becomes a
 * finding instead.
 */
export function analyzeOpenApi(input = {}) {
  if (!isRecord(input)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(input)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  const limits = validateLimits(input.limits)
  const source = label(input.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  const deadline = createDeadline(clock, limits.maxMillis)
  const collector = createCollector()
  const state = { version: null, title: null, operations: 0, examples: 0, checked: 0 }

  if (deadline.exceeded()) {
    record(collector, {
      ruleId: 'time-budget-exceeded',
      parts: [],
      message: `Analysis passed the maxMillis budget of ${limits.maxMillis} before the document was read.`,
      suggestion: 'Raise --max-millis deliberately.',
    })
    return finish(collector, state, source)
  }

  const document = readDocument(input.bytes, limits)
  if (!document.ok) {
    record(collector, {
      ruleId: document.ruleId,
      parts: [],
      message: document.message,
      evidence: document.evidence,
      suggestion: document.suggestion,
    })
    return finish(collector, state, source)
  }

  const version = detectVersion(document.document)
  if (!version.ok) {
    record(collector, {
      ruleId: version.ruleId,
      parts: ['openapi'],
      message: version.message,
      evidence: version.evidence,
      suggestion: version.suggestion,
    })
    return finish(collector, state, source)
  }
  state.version = label(version.version, 40)
  const info = document.document.info
  state.title = isRecord(info) && typeof info.title === 'string' ? label(info.title) : null

  const context = {
    root: document.document,
    dialect: version.dialect,
    limits,
    deadline,
    collector,
    state,
    resolver: createResolver(document.document, limits),
    patterns: new Map(),
    budget: limits.maxNodes,
    halted: false,
  }

  checkDocumentDialect(context)
  walkPaths(context)

  /**
   * Green on no evidence is a defect, not a clean bill of health. A run that
   * checked nothing did not agree with the description; it failed to disagree
   * with it. The finding alone would not prevent a pass -- it is a warning --
   * so `no-examples-declared` is also in INCOMPLETE_RULES, and that membership
   * is the only thing between an example-free description and a green build.
   */
  if (state.checked === 0) {
    record(collector, {
      ruleId: 'no-examples-declared',
      parts: ['paths'],
      message: 'No example was checked against a schema in this run, so it is evidence of nothing.',
      suggestion: 'Declare an example under a request body or a response, or check why the ones declared were not reachable.',
    })
  }

  return finish(collector, state, source)
}

/** OpenAPI 3.1 lets the document name the dialect its schemas are written in. */
function checkDocumentDialect(context) {
  const declared = context.root.jsonSchemaDialect
  if (declared === undefined) return
  if (context.dialect === '3.0') {
    record(context.collector, {
      ruleId: 'schema-dialect-unsupported',
      parts: ['jsonSchemaDialect'],
      message: 'An OpenAPI 3.0 document may not declare "jsonSchemaDialect", so the dialect of its schemas is unclear.',
      evidence: typeof declared === 'string' ? declared : typeof declared,
      suggestion: 'Remove the key, or describe the API with OpenAPI 3.1.',
    })
    return
  }
  if (typeof declared !== 'string' || !SUPPORTED_DIALECTS.includes(declared)) {
    record(context.collector, {
      ruleId: 'schema-dialect-unsupported',
      parts: ['jsonSchemaDialect'],
      message: `This tool models the ${SUPPORTED_DIALECTS[0]} dialect only, so no schema in this document was evaluated.`,
      evidence: typeof declared === 'string' ? declared : typeof declared,
      suggestion: 'Declare the 2020-12 dialect, or check the examples by hand.',
    })
  }
}

function spend(context, cost) {
  if (context.halted) return false
  context.budget -= cost
  if (context.budget < 0) {
    context.halted = true
    record(context.collector, {
      ruleId: 'node-budget-exceeded',
      parts: ['paths'],
      message: `The walk passed the maxNodes limit of ${context.limits.maxNodes}, so part of the description was not examined.`,
      suggestion: 'Raise --max-nodes deliberately, or split the description.',
    })
    return false
  }
  if (context.deadline.exceeded()) {
    context.halted = true
    record(context.collector, {
      ruleId: 'time-budget-exceeded',
      parts: ['paths'],
      message: `The walk passed the maxMillis budget of ${context.limits.maxMillis}, so part of the description was not examined.`,
      suggestion: 'Raise --max-millis deliberately, or split the description.',
    })
    return false
  }
  return true
}

function malformed(context, parts, message, evidence) {
  record(context.collector, {
    ruleId: 'operation-malformed',
    parts,
    message,
    evidence,
    suggestion: 'Correct the shape of this object; nothing under it was examined.',
  })
}

/**
 * Follow a `$ref` at a structural position, turning a refusal into a finding.
 *
 * Returns `null` when the node could not be obtained, which every caller treats
 * as "stop here": whatever was under it is unexamined, and the run is already
 * incomplete because every refusal rule is in INCOMPLETE_RULES.
 */
function follow(context, node, parts, what) {
  const resolved = context.resolver.resolve(node, parts)
  if (!resolved.ok) {
    record(context.collector, {
      ruleId: resolved.ruleId,
      parts,
      message: `${resolved.message} So the ${what} it names was not examined.`,
      evidence: resolved.evidence,
      suggestion: 'Declare it in this document, or check the examples under it by hand.',
    })
    return null
  }
  if (resolved.hops > 0 && !spend(context, resolved.hops)) return null
  return resolved
}

function walkPaths(context) {
  const paths = context.root.paths
  if (paths === undefined) return
  if (!isRecord(paths)) {
    record(context.collector, {
      ruleId: 'document-malformed',
      parts: ['paths'],
      message: 'The "paths" member is not an object, so no operation in this description was examined.',
      evidence: Array.isArray(paths) ? 'array' : typeof paths,
      suggestion: 'Declare "paths" as an object keyed by path template.',
    })
    return
  }

  for (const template of Object.keys(paths)) {
    if (!spend(context, 1)) return
    const parts = ['paths', label(template)]
    const resolved = follow(context, paths[template], parts, 'path item')
    if (resolved === null) continue
    const item = resolved.value
    if (!isRecord(item)) {
      malformed(context, resolved.parts, 'This path item is not an object.', typeof item)
      continue
    }
    if (Object.hasOwn(item, 'parameters')) {
      walkParameters(context, item.parameters, [...resolved.parts, 'parameters'])
    }
    for (const method of METHODS) {
      if (!Object.hasOwn(item, method)) continue
      if (!spend(context, 1)) return
      context.state.operations += 1
      if (context.state.operations > context.limits.maxOperations) {
        context.halted = true
        record(context.collector, {
          ruleId: 'too-many-operations',
          parts: ['paths'],
          message: `The description declares more than the maxOperations limit of ${context.limits.maxOperations}, so the rest were not examined.`,
          suggestion: 'Raise --max-operations deliberately, or split the description.',
        })
        return
      }
      walkOperation(context, item[method], [...resolved.parts, method])
    }
  }
}

function walkOperation(context, operation, parts) {
  if (!isRecord(operation)) {
    malformed(context, parts, 'This operation is not an object.', Array.isArray(operation) ? 'array' : typeof operation)
    return
  }
  if (Object.hasOwn(operation, 'parameters')) {
    walkParameters(context, operation.parameters, [...parts, 'parameters'])
  }
  if (Object.hasOwn(operation, 'requestBody')) {
    const resolved = follow(context, operation.requestBody, [...parts, 'requestBody'], 'request body')
    if (resolved !== null) {
      if (!isRecord(resolved.value)) malformed(context, resolved.parts, 'This request body is not an object.', typeof resolved.value)
      else if (Object.hasOwn(resolved.value, 'content')) walkContent(context, resolved.value.content, [...resolved.parts, 'content'])
    }
  }
  if (!Object.hasOwn(operation, 'responses')) return
  const responses = operation.responses
  if (!isRecord(responses)) {
    malformed(context, [...parts, 'responses'], 'The "responses" member is not an object.', Array.isArray(responses) ? 'array' : typeof responses)
    return
  }
  for (const status of Object.keys(responses)) {
    if (!spend(context, 1)) return
    const responseParts = [...parts, 'responses', label(status, 40)]
    const resolved = follow(context, responses[status], responseParts, 'response')
    if (resolved === null) continue
    if (!isRecord(resolved.value)) {
      malformed(context, resolved.parts, 'This response is not an object.', typeof resolved.value)
      continue
    }
    if (Object.hasOwn(resolved.value, 'content')) walkContent(context, resolved.value.content, [...resolved.parts, 'content'])
    if (Object.hasOwn(resolved.value, 'headers')) walkHeaders(context, resolved.value.headers, [...resolved.parts, 'headers'])
  }
}

function walkParameters(context, parameters, parts) {
  if (!Array.isArray(parameters)) {
    malformed(context, parts, 'The "parameters" member is not an array.', isRecord(parameters) ? 'object' : typeof parameters)
    return
  }
  for (let index = 0; index < parameters.length; index += 1) {
    if (!spend(context, 1)) return
    const resolved = follow(context, parameters[index], [...parts, String(index)], 'parameter')
    if (resolved === null) continue
    if (!isRecord(resolved.value)) {
      malformed(context, resolved.parts, 'This parameter is not an object.', typeof resolved.value)
      continue
    }
    walkSchemaCarrier(context, resolved.value, resolved.parts, 'parameter')
  }
}

function walkHeaders(context, headers, parts) {
  if (!isRecord(headers)) {
    malformed(context, parts, 'The "headers" member is not an object.', Array.isArray(headers) ? 'array' : typeof headers)
    return
  }
  for (const name of Object.keys(headers)) {
    if (!spend(context, 1)) return
    const resolved = follow(context, headers[name], [...parts, label(name, 80)], 'header')
    if (resolved === null) continue
    if (!isRecord(resolved.value)) {
      malformed(context, resolved.parts, 'This header is not an object.', typeof resolved.value)
      continue
    }
    walkSchemaCarrier(context, resolved.value, resolved.parts, 'header')
  }
}

/**
 * A parameter or a header: either a `content` map, or a bare `schema` whose
 * examples are plain values rather than a serialised payload.
 */
function walkSchemaCarrier(context, node, parts, what) {
  if (Object.hasOwn(node, 'content')) {
    walkContent(context, node.content, [...parts, 'content'])
    return
  }
  const sites = collectSites(context, node, parts)
  if (sites.length === 0) return
  if (!Object.hasOwn(node, 'schema')) {
    record(context.collector, {
      ruleId: 'schema-missing',
      parts,
      message: `This ${what} declares ${sites.length} example(s) but no schema, so none of them could be checked against anything.`,
      suggestion: 'Declare a schema beside the example.',
    })
    return
  }
  for (const site of sites) checkSite(context, site, node.schema, [...parts, 'schema'], 'json')
}

function walkContent(context, content, parts) {
  if (!isRecord(content)) {
    malformed(context, parts, 'A "content" member is not an object.', Array.isArray(content) ? 'array' : typeof content)
    return
  }
  for (const mediaType of Object.keys(content)) {
    if (!spend(context, 1)) return
    const mediaParts = [...parts, label(mediaType, 80)]
    const media = content[mediaType]
    if (!isRecord(media)) {
      malformed(context, mediaParts, 'This media type object is not an object.', Array.isArray(media) ? 'array' : typeof media)
      continue
    }
    const sites = collectSites(context, media, mediaParts)
    const classified = classifyMediaType(mediaType)
    if (classified.kind !== 'json' && classified.kind !== 'text') {
      record(context.collector, {
        ruleId: 'media-type-unsupported',
        parts: mediaParts,
        message: unsupportedMediaMessage(classified, sites.length),
        evidence: label(mediaType, 80),
        suggestion: 'Check these examples by hand, or describe the payload as JSON or text/plain.',
      })
      continue
    }
    if (sites.length === 0) continue
    if (!Object.hasOwn(media, 'schema')) {
      record(context.collector, {
        ruleId: 'schema-missing',
        parts: mediaParts,
        message: `This media type declares ${sites.length} example(s) but no schema, so none of them could be checked against anything.`,
        evidence: label(mediaType, 80),
        suggestion: 'Declare a schema beside the examples.',
      })
      continue
    }
    for (const site of sites) {
      checkSite(context, site, media.schema, [...mediaParts, 'schema'], classified.kind)
    }
  }
}

function unsupportedMediaMessage(classified, count) {
  if (classified.kind === 'malformed') {
    return `This content key is not a media type, so the ${count} example(s) under it were not checked.`
  }
  if (classified.kind === 'charset') {
    return `This media type declares a charset other than UTF-8, which this tool does not model, so the ${count} example(s) under it were not checked.`
  }
  return `This tool models JSON media types and text/plain only, so the ${count} example(s) under "${classified.essence}" were not checked.`
}

/**
 * Gather the example values declared beside a schema.
 *
 * `example` and `examples` are mutually exclusive in OpenAPI. Declaring both is
 * reported, and then both are checked anyway: refusing to look would turn a
 * declaration mistake into an unexamined payload.
 */
function collectSites(context, node, parts) {
  const sites = []
  const hasSingular = Object.hasOwn(node, 'example')
  const hasPlural = Object.hasOwn(node, 'examples')
  if (hasSingular && hasPlural) {
    record(context.collector, {
      ruleId: 'example-declaration-conflict',
      parts,
      message: 'Both "example" and "examples" are declared here, and OpenAPI allows only one of them; both were checked.',
      suggestion: 'Keep "examples" and remove "example", or the other way round.',
    })
  }
  if (hasSingular) sites.push({ parts: [...parts, 'example'], value: node.example, name: null })
  if (!hasPlural) return sites

  const declared = node.examples
  if (!isRecord(declared)) {
    malformed(context, [...parts, 'examples'], 'An "examples" member is not an object keyed by example name.', Array.isArray(declared) ? 'array' : typeof declared)
    return sites
  }
  for (const name of Object.keys(declared)) {
    const exampleParts = [...parts, 'examples', label(name, 80)]
    if (!spend(context, 1)) return sites
    const resolved = follow(context, declared[name], exampleParts, 'example')
    if (resolved === null) continue
    if (!isRecord(resolved.value)) {
      malformed(context, resolved.parts, 'This example object is not an object.', Array.isArray(resolved.value) ? 'array' : typeof resolved.value)
      continue
    }
    if (Object.hasOwn(resolved.value, 'externalValue')) {
      record(context.collector, {
        ruleId: 'example-external-value',
        parts: resolved.parts,
        message: 'This example lives in another document. Nothing is fetched, so its value was never obtained and nothing about it was checked.',
        evidence: typeof resolved.value.externalValue === 'string' ? resolved.value.externalValue : typeof resolved.value.externalValue,
        suggestion: 'Inline the value under "value", or check this example by hand.',
      })
      continue
    }
    if (!Object.hasOwn(resolved.value, 'value')) {
      malformed(context, resolved.parts, 'This example object declares neither "value" nor "externalValue".', undefined)
      continue
    }
    sites.push({ parts: [...resolved.parts, 'value'], value: resolved.value.value, name: label(name, 80) })
  }
  return sites
}

/**
 * Check one example value against one schema.
 *
 * The bounds come first and each one refuses the example whole: an example over
 * `maxExampleBytes` or `maxExampleDepth` is reported by name and not walked,
 * because walking half of it and reporting what that half contained would be
 * the silent truncation the limits exist to prevent.
 */
function checkSite(context, site, schema, schemaParts, mode) {
  if (context.halted) return
  context.state.examples += 1
  if (context.state.examples > context.limits.maxExamples) {
    context.halted = true
    record(context.collector, {
      ruleId: 'too-many-examples',
      parts: ['paths'],
      message: `The description declares more than the maxExamples limit of ${context.limits.maxExamples}, so the rest were not checked.`,
      suggestion: 'Raise --max-examples deliberately, or split the description.',
    })
    return
  }
  if (!spend(context, 1)) return

  const bytes = measureBytes(site.value)
  if (bytes === null || bytes > context.limits.maxExampleBytes) {
    record(context.collector, {
      ruleId: 'example-too-large',
      parts: site.parts,
      message: `This example is ${bytes === null ? 'not serialisable' : `${bytes} bytes, over the maxExampleBytes limit of ${context.limits.maxExampleBytes}`}, so it was not checked.`,
      suggestion: 'Raise --max-example-bytes deliberately, or shorten the example.',
    })
    return
  }
  const depth = measureDepth(site.value, context.limits.maxExampleDepth)
  if (depth.exceeded) {
    record(context.collector, {
      ruleId: 'example-too-deep',
      parts: site.parts,
      message: `This example nests deeper than the maxExampleDepth limit of ${context.limits.maxExampleDepth}, so it was not checked.`,
      suggestion: 'Raise --max-example-depth deliberately, or flatten the example.',
    })
    return
  }
  if (mode === 'text' && typeof site.value !== 'string') {
    record(context.collector, {
      ruleId: 'example-not-text',
      parts: site.parts,
      message: 'This example sits under a text media type but is not a string, so it cannot be the payload it describes.',
      evidence: Array.isArray(site.value) ? 'array' : site.value === null ? 'null' : typeof site.value,
      suggestion: 'Write the payload as a string, or move the example to a JSON media type.',
    })
    return
  }

  const result = validateExample(site.value, schema, {
    dialect: context.dialect,
    limits: context.limits,
    resolver: context.resolver,
    deadline: context.deadline,
    budget: context.budget,
    patterns: context.patterns,
    exampleParts: site.parts,
    schemaParts,
  })
  context.budget = result.budget
  if (result.halted) context.halted = true
  for (const problem of result.problems) {
    record(context.collector, {
      ruleId: problem.ruleId,
      parts: problem.parts,
      message: problem.message,
      evidence: problem.evidence,
      suggestion: problem.suggestion,
    })
  }
  /**
   * An example only counts as checked when a schema for it was obtained and
   * fully applied. A structural problem -- a reference that was refused, a
   * keyword this tool does not model, a cycle -- means part of the schema was
   * never evaluated, so counting the example would be counting a question as an
   * answer. This is the difference between `summary.checked` and
   * `summary.examples`, and it is why "checked: 0" is reachable in a
   * description full of examples.
   */
  const blocked = result.problems.some((problem) => problem.kind === 'structural')
  if (!result.halted && !blocked) context.state.checked += 1
}

/* -------------------------------------------------------------------------- */

function finish(collector, state, source) {
  collector.rows.sort(compareFindingRows)
  const findings = collector.rows.map((row) => {
    const finding = {
      ruleId: row.ruleId,
      severity: row.severity,
      message: row.message,
      location: { file: source, pointer: row.pointer },
    }
    if (row.evidence !== null) finding.evidence = row.evidence
    if (row.suggestion !== null) finding.suggestion = row.suggestion
    return finding
  })
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      operations: state.operations,
      examples: state.examples,
      unknown: collector.rows.filter((row) => INCOMPLETE.has(row.ruleId)).length,
    },
    findings,
  }
  return { report, version: state.version, title: state.title }
}

/* -------------------------------------------------------------------------- */

/**
 * Read a description from the filesystem and analyse it.
 *
 * A file that cannot be read is a subject the run had and failed to obtain
 * evidence about, so it produces a report with status `incomplete` -- not a
 * thrown error, and never an empty stdout. The distinction matters to a
 * consumer: it needs to know *which* input was not read.
 */
export async function validateOpenApiFile(path, options = {}) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    const collector = createCollector()
    record(collector, {
      ruleId: 'document-unreadable',
      parts: [],
      message: 'The description could not be read, so nothing in it was checked.',
      evidence: error.code ?? 'read-failed',
      suggestion: 'Check the path and the permissions on the file.',
    })
    const source = label(options.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
    return finish(collector, { version: null, title: null, operations: 0, examples: 0, checked: 0 }, source)
  }
  return analyzeOpenApi({
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    source: options.source,
    limits: options.limits,
    clock: options.clock,
  })
}

/** The human-readable summary. Machine-readable output goes to `--json`. */
export function formatReport(result) {
  const { report } = result
  const { summary } = report
  const name = result.title === null ? '(untitled)' : `"${result.title}"`
  const lines = [
    `openapi ${result.version ?? '(unknown)'} ${name}: ${summary.checked} of ${summary.examples} example(s) checked `
    + `across ${summary.operations} operation(s), ${summary.errors} error, ${summary.warnings} warning, `
    + `${summary.info} info, ${summary.unknown} unanswered, status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} `
      + `${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { DEFAULT_LIMITS, detectVersion, isRecord, readDocument, validateLimits } from './document.mjs'
export { classifyRef, createResolver, rotateCycle } from './refs.mjs'
export { ASSERTED_FORMATS, SUPPORTED_DIALECTS, deepEqual, isMultipleOf, keywordsFor, validateExample } from './schema.mjs'
export { analyzePattern, estimatePatternWork } from './pattern.mjs'
export { byCodeUnit, decodeUtf8, sanitize } from './text.mjs'
export { escapeSegment, measureDepth, parseFragment, pointerOf, resolvePointerParts } from './pointer.mjs'
