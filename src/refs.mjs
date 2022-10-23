/**
 * `$ref` classification and resolution.
 *
 * Three properties are deliberate and each one is a refusal rather than a
 * best effort:
 *
 * 1. **Nothing is fetched.** A `$ref` carrying a URI scheme is refused, not
 *    resolved. An OpenAPI description is untrusted input; a validator that
 *    opened a socket because a document asked it to would be a fetcher that
 *    reports, not a checker.
 * 2. **Nothing outside the one document is read.** A file-relative `$ref` is
 *    refused as unsupported. This tool reads exactly one file, which is why it
 *    has no root to confine and no symlink to resolve.
 * 3. **A cycle is named, not recursed into.** A chain that returns to a pointer
 *    it already visited is reported with the cycle written out, rooted at its
 *    code-unit-smallest member so two runs describe it identically.
 *
 * A refused reference is never treated as satisfied: the caller turns each of
 * these into a finding that marks the run incomplete, because the schema the
 * example was to be checked against was never obtained.
 */

import { isRecord } from './document.mjs'
import { parseFragment, pointerOf, resolvePointerParts } from './pointer.mjs'
import { byCodeUnit } from './text.mjs'

/** Siblings a `$ref` object may carry. OpenAPI 3.1 allows exactly these two. */
const ALLOWED_SIBLINGS = new Set(['$ref', 'summary', 'description'])

/**
 * Decide what kind of reference a `$ref` string is, without resolving it.
 *
 * A scheme -- `https:`, `file:`, `urn:` -- makes it remote whatever it points
 * at; a leading `//` is protocol-relative and equally remote. Everything that
 * is not a bare fragment is a reference into another file.
 */
export function classifyRef(raw) {
  if (typeof raw !== 'string') return { kind: 'malformed', reason: 'not-a-string' }
  if (raw === '') return { kind: 'malformed', reason: 'empty' }
  if (raw.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return { kind: 'remote' }
  if (!raw.startsWith('#')) return { kind: 'file' }
  const fragment = parseFragment(raw.slice(1))
  if (!fragment.ok) return { kind: 'malformed', reason: fragment.reason }
  return { kind: 'local', parts: fragment.parts }
}

/**
 * Write a cycle from a fixed starting point.
 *
 * A cycle has no inherent first member -- which pointer the walk happened to
 * enter it from is an accident of where an example was declared. Rooting it at
 * the code-unit-smallest member makes two runs that enter the same cycle from
 * different sites describe it with the same string.
 */
export function rotateCycle(cycle) {
  let best = 0
  for (let index = 1; index < cycle.length; index += 1) {
    if (byCodeUnit(cycle[index], cycle[best]) < 0) best = index
  }
  return [...cycle.slice(best), ...cycle.slice(0, best)]
}

const REASON_TEXT = Object.freeze({
  'not-a-string': 'a "$ref" must be a string',
  empty: 'a "$ref" must not be empty',
  anchor: 'this tool resolves JSON Pointer fragments only, not anchors',
  escape: 'the fragment contains a "~" that is not part of "~0" or "~1"',
  percent: 'the fragment is not valid percent-encoding',
  siblings: 'a "$ref" object may carry only "summary" and "description" beside it',
})

/**
 * Follow a `$ref` chain to the node it names, or to the reason it could not be
 * followed.
 *
 * The chain starts at the referring site so that a self-referential component
 * is caught on its first hop. `hops` is returned so the caller can charge the
 * traversal budget for work done here.
 */
export function createResolver(root, limits) {
  return {
    resolve(node, parts) {
      let current = node
      let currentParts = parts
      const chain = [pointerOf(parts)]
      let hops = 0

      while (isRecord(current) && Object.hasOwn(current, '$ref')) {
        const problem = (ruleId, message, evidence) => ({ ok: false, ruleId, message, evidence, hops })
        for (const key of Object.keys(current)) {
          if (!ALLOWED_SIBLINGS.has(key)) {
            return problem('ref-malformed', `This reference could not be followed: ${REASON_TEXT.siblings}.`, key)
          }
        }
        const classified = classifyRef(current.$ref)
        if (classified.kind === 'malformed') {
          return problem(
            'ref-malformed',
            `This reference could not be followed: ${REASON_TEXT[classified.reason]}.`,
            typeof current.$ref === 'string' ? current.$ref : typeof current.$ref,
          )
        }
        if (classified.kind === 'remote') {
          return problem(
            'ref-remote-refused',
            'This reference names a remote document. Nothing is fetched, so the schema it points at was never obtained.',
            current.$ref,
          )
        }
        if (classified.kind === 'file') {
          return problem(
            'ref-external-file-unsupported',
            'This reference names another file. This tool reads one document, so the schema it points at was never obtained.',
            current.$ref,
          )
        }

        hops += 1
        if (hops > limits.maxRefDepth) {
          return problem(
            'ref-depth-exceeded',
            `This reference chain is longer than the maxRefDepth limit of ${limits.maxRefDepth}, so it was not followed to the end.`,
            current.$ref,
          )
        }

        const targetPointer = pointerOf(classified.parts)
        const seen = chain.indexOf(targetPointer)
        if (seen !== -1) {
          const cycle = rotateCycle(chain.slice(seen))
          return problem(
            'ref-cycle',
            'This reference chain returns to a node it already visited, so it was reported rather than followed.',
            [...cycle, cycle[0]].join(' -> '),
          )
        }

        const resolved = resolvePointerParts(root, classified.parts)
        if (!resolved.ok) {
          return problem(
            'ref-unresolved',
            'This reference names a position the document does not contain, so nothing was obtained from it.',
            current.$ref,
          )
        }

        chain.push(targetPointer)
        current = resolved.value
        currentParts = classified.parts
      }

      return { ok: true, value: current, parts: currentParts, hops }
    },
  }
}
