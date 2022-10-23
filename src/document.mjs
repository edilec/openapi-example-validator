/**
 * The limits, and the one place bytes become a document.
 *
 * Every limit in this file is documented in `docs/example-rules.md`, wired to a
 * command line flag, and reported by name when it is reached. A limit that is
 * accepted and never enforced is how a real failure turns into a green run, so
 * `test/limits.test.mjs` drives each one from both sides of its bound.
 */

import { measureDepth } from './pointer.mjs'
import { decodeUtf8, sanitize } from './text.mjs'

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The declared bounds.
 *
 * `maxNodes` is the traversal budget: every document node the walk visits and
 * every example node the validator inspects spends one. It is what stops a
 * document that is small on disk but expensive to analyse -- a thousand
 * examples against a schema with a thousand branches -- from running forever
 * without anyone having written a timeout.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 2097152,
  maxDepth: 40,
  maxNodes: 200000,
  maxOperations: 500,
  maxExamples: 2000,
  maxExampleBytes: 65536,
  maxExampleDepth: 24,
  maxRefDepth: 16,
  maxEvalDepth: 512,
  maxPatternLength: 200,
  maxMillis: 5000,
})

/** Every limit is a positive integer except the time budget, where 0 means "no time at all". */
const LIMIT_FLOOR = Object.freeze({ maxMillis: 0 })

/**
 * Validate a caller-supplied limit set.
 *
 * An unknown key throws rather than being ignored: `maxExamplesBytes` for
 * `maxExampleBytes` would otherwise enforce the default while the caller
 * believed it had raised the bound, and the run would be green for the wrong
 * reason. This is configuration, so it throws instead of becoming a finding --
 * a run that never had a valid subject has nothing to report about.
 */
export function validateLimits(input) {
  if (input === undefined || input === null) return { ...DEFAULT_LIMITS }
  if (!isRecord(input)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError(`Unknown limit "${sanitize(key, 60)}"`)
    const floor = LIMIT_FLOOR[key] ?? 1
    if (!Number.isInteger(value) || value < floor) {
      throw new TypeError(`Limit "${key}" must be an integer of at least ${floor}`)
    }
    limits[key] = value
  }
  return limits
}

/**
 * Turn bytes into a parsed document, or into the reason that failed.
 *
 * The order matters. Size is checked before decoding so an enormous file is
 * never held as a string; decoding is strict and comes before parsing so an
 * encoding fault is never reported as a syntax fault; depth is measured before
 * anything walks the document so a deeply nested input cannot overflow a stack
 * on its way to being refused.
 */
export function readDocument(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array')
  if (bytes.length > limits.maxBytes) {
    return {
      ok: false,
      ruleId: 'document-too-large',
      message: `The document is ${bytes.length} bytes, over the maxBytes limit of ${limits.maxBytes}, so it was not parsed.`,
      suggestion: 'Raise --max-bytes deliberately, or split the description.',
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      ruleId: 'document-not-utf8',
      message: 'The document is not valid UTF-8, so no part of it could be read.',
      suggestion: 'Re-encode the description as UTF-8.',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return {
      ok: false,
      ruleId: 'document-not-json',
      message: 'The document is not JSON, so no example in it could be checked.',
      evidence: error.message,
      suggestion: 'This tool reads JSON only; convert a YAML description to JSON first.',
    }
  }
  const depth = measureDepth(parsed, limits.maxDepth)
  if (depth.exceeded) {
    return {
      ok: false,
      ruleId: 'document-too-deep',
      message: `The document nests deeper than the maxDepth limit of ${limits.maxDepth}, so it was not walked.`,
      suggestion: 'Raise --max-depth deliberately, or flatten the description.',
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      ruleId: 'document-malformed',
      message: 'The document is valid JSON but not an object, so it is not an OpenAPI description.',
      suggestion: 'Point --spec at an OpenAPI description.',
    }
  }
  return { ok: true, document: parsed }
}

/** The two minor versions whose Schema Object this tool models. */
export const SUPPORTED_OPENAPI = Object.freeze(['3.0', '3.1'])

/**
 * Decide which dialect the document's schemas are written in.
 *
 * The distinction is not cosmetic. In 3.0 a nullable field is spelled
 * `nullable: true` and `exclusiveMinimum` is a boolean modifier on `minimum`;
 * in 3.1 the same field is spelled `type: ["string", "null"]` and
 * `exclusiveMinimum` is itself a number. Validating one dialect's document with
 * the other's rules would report failures that are not there and miss ones that
 * are, so an unrecognised version is refused instead of assumed.
 */
export function detectVersion(document) {
  const raw = document.openapi
  if (raw === undefined) {
    return {
      ok: false,
      ruleId: 'openapi-version-missing',
      message: 'The document declares no "openapi" version, so the dialect of its schemas is unknown.',
      suggestion: 'Declare "openapi": "3.1.0" (or the 3.0.x version the description targets).',
    }
  }
  if (typeof raw !== 'string' || !/^3\.[01]\.\d+$/.test(raw)) {
    return {
      ok: false,
      ruleId: 'openapi-version-unsupported',
      message: `This tool models OpenAPI ${SUPPORTED_OPENAPI.join(' and ')} only; the document declares a version it does not model.`,
      evidence: typeof raw === 'string' ? raw : typeof raw,
      suggestion: 'Validate a 3.0.x or 3.1.x description, or check the examples by hand.',
    }
  }
  return { ok: true, version: raw, dialect: raw.slice(0, 3) }
}
