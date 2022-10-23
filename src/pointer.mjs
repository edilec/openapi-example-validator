/**
 * JSON Pointer (RFC 6901) construction, parsing and resolution, plus the two
 * bounded measurements taken of every example value.
 *
 * A finding is only as useful as the position it names, so pointers are built
 * from the same segments the document used and escaped exactly once. Segments
 * are sanitised by the caller before they arrive here: escaping a newline as
 * `~1` would be wrong, and leaving it unescaped would forge a report line.
 */

import { POINTER_LIMIT, sanitize } from './text.mjs'

/** `~` becomes `~0` and `/` becomes `~1`, in that order, per RFC 6901. */
export function escapeSegment(segment) {
  return String(segment).split('~').join('~0').split('/').join('~1')
}

/** The inverse, applied in the reverse order so `~01` decodes to `~1`. */
export function unescapeSegment(segment) {
  return segment.split('~1').join('/').split('~0').join('~')
}

/** Join already-sanitised segments into a pointer. An empty list is the root. */
export function pointerOf(parts) {
  if (parts.length === 0) return ''
  return `/${parts.map((part) => escapeSegment(part)).join('/')}`
}

/** A pointer for a report, bounded and stripped of anything that forges a line. */
export function reportPointer(parts) {
  return sanitize(pointerOf(parts), POINTER_LIMIT)
}

/**
 * Parse the fragment of a local `$ref` into pointer segments.
 *
 * Only two shapes are accepted: the empty fragment, which is the document
 * root, and a fragment beginning with `/`. An anchor fragment such as `#Pet`
 * is a different resolution mechanism that this tool does not implement, so it
 * is refused here rather than guessed at.
 */
export function parseFragment(fragment) {
  if (fragment === '') return { ok: true, parts: [] }
  if (!fragment.startsWith('/')) return { ok: false, reason: 'anchor' }
  const parts = []
  for (const raw of fragment.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return { ok: false, reason: 'escape' }
    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return { ok: false, reason: 'percent' }
    }
    parts.push(unescapeSegment(decoded))
  }
  return { ok: true, parts }
}

/**
 * Walk a parsed document by pointer segments.
 *
 * An array index must be a canonical decimal without a leading zero: `/0` and
 * `/10` resolve, `/01` and `/+1` do not. Reading a property off an array by
 * name -- `/length` -- is refused too, because it would resolve to something
 * the document never wrote.
 */
export function resolvePointerParts(root, parts) {
  let node = root
  for (const part of parts) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part)) return { ok: false }
      const index = Number(part)
      if (index >= node.length) return { ok: false }
      node = node[index]
      continue
    }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return { ok: false }
    node = node[part]
  }
  return { ok: true, value: node }
}

/**
 * The nesting depth of a parsed value, measured iteratively.
 *
 * Recursion here would trade one unbounded input for a stack overflow, which
 * is a crash rather than a finding. The walk stops as soon as the limit is
 * passed: the answer past that point is "deeper than allowed", and computing
 * how much deeper would be doing the work the limit exists to refuse.
 */
export function measureDepth(value, limit) {
  const stack = [[value, 1]]
  let deepest = 0
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (depth > deepest) deepest = depth
    if (deepest > limit) return { depth: deepest, exceeded: true }
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1])
    } else if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) stack.push([node[key], depth + 1])
    }
  }
  return { depth: deepest, exceeded: false }
}

/** The UTF-8 size of a value once serialised, used for the example byte limit. */
export function measureBytes(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return null
  }
  if (text === undefined) return null
  return new TextEncoder().encode(text).length
}
