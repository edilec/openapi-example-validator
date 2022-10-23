/**
 * Decoding, ordering and sanitising primitives.
 *
 * Nothing here touches the filesystem, the clock, the locale, the environment
 * or the network. Every export is a pure function of its arguments, which is
 * what lets the same OpenAPI document produce byte-identical output on any
 * host, on any Node build, under any locale.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both consult ICU collation data that
 * differs between Node builds and platforms. A report is diffed between
 * machines and pasted into issues, so no part of its order may depend on that
 * data. The difference is real and reachable from an OpenAPI document: a
 * collator puts `assets` before `README`, and orders `a_b` before `a-b`
 * because it weighs `_` and `-` differently from their code points.
 *
 * Pinning this helper in isolation pins nothing but this helper -- every call
 * site can still be swapped one at a time. `test/ordering.test.mjs` pins each
 * call site instead, through the real entry point, on values whose collated
 * order genuinely differs from their code-unit order.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then hunting for U+FFFD
 * cannot tell undecodable bytes apart from a document that legitimately
 * contains a replacement character, and that confusion has let an unreadable
 * input report a pass elsewhere in this catalog. The decoder decides; the
 * decoded text never gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed from every document-derived string on its way to output.
 *
 * Built from code points rather than written literally, because a literal
 * U+2028 in a module is itself a hazard and the whole point of the class is
 * that these characters never reach a report line. Each class forges or hides
 * something in an output a person reads:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   line in the human report; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which starts a new line on a
 *   terminal exactly as a newline does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a filter that stops at C0 lets both reach
 *   stdout intact.
 * - **U+2028 and U+2029**: they terminate a line for a JavaScript consumer and
 *   `JSON.stringify` does not escape them either.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses the text displayed after it, so a path called one thing is read as
 *   another; the isolates hide what they wrap.
 *
 * This applies to identifiers, not only to excerpts. A path template, a media
 * type key, an example name, a property name, a `$ref` string and an unknown
 * schema keyword are all strings the author of an untrusted document chose, and
 * every one of them reaches a pointer or a message.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/** Bounds on what any one document-derived string may contribute to output. */
export const EXCERPT_LIMIT = 200
export const MESSAGE_LIMIT = 400
export const LABEL_LIMIT = 120
export const POINTER_LIMIT = 400

/**
 * A bounded, single-line, control-free rendering of a document-derived string.
 *
 * Every string that came out of the document passes through here on its way to
 * the report: pointer segments, messages, evidence, the API title, the
 * `openapi` version string, media types, formats and type names. Sanitising
 * only an excerpt field has already let an identifier carrying a newline forge
 * whole lines in a human report elsewhere in this catalog.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Sanitise limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Render an example value for the `evidence` field.
 *
 * `JSON.stringify` escapes C0 inside strings but leaves U+2028, U+2029 and the
 * bidi controls intact, and it does not touch a key at all, so the result still
 * goes through `sanitize`. The value is truncated before stringifying only in
 * the sense that the result is bounded afterwards -- an enormous value is
 * rejected by `maxExampleBytes` long before it reaches here.
 */
export function renderValue(value, limit = EXCERPT_LIMIT) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return sanitize(text === undefined ? 'undefined' : text, limit)
}
