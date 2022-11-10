/**
 * The subset of regular expressions this tool will actually run.
 *
 * A `pattern` comes out of an untrusted description and is compiled into a real
 * regular expression, so the question is not whether the expression is valid
 * but whether its matching cost can be bounded *before* it runs. It cannot be
 * bounded afterwards: the engine does not yield, so a deadline checked between
 * operations never fires during one. A pattern that takes six seconds under a
 * hundred-millisecond budget is not interrupted, it is waited for.
 *
 * So the bound is decided here, from the pattern and the subject, before a
 * single character is matched. Two things are computed:
 *
 * 1. **Is this shape one whose cost is a function of the subject length at
 *    all?** Backtracking explodes when two parts of a pattern compete for the
 *    same characters: `(a+)+` is exponential in the subject, and `a*a*a*` --
 *    which has no group in it, and which the previous version of this check let
 *    through -- costs the subject length raised to the number of competing
 *    quantifiers. Every shape that cannot be decomposed here is refused by
 *    name, not approximated.
 * 2. **How much work would this subject be?** An upper-bound estimate --
 *    starting positions, times alternation branches, times variable-length
 *    terms, times the subject length once per walk the engine can be made to
 *    repeat -- is compared against `maxPatternSteps`. Over it, the pattern is
 *    not applied and the example is reported as unchecked.
 *
 * Both refusals are `schema-pattern-unsupported`, which makes the run
 * `incomplete`. Neither is ever a pass: a pattern that was not applied is a
 * question this tool did not answer.
 *
 * The analysis is deliberately conservative and says so. It over-approximates
 * every character set it is not sure of, and it refuses constructs -- lookaround,
 * backreferences, a quantified group with anything but a fixed sequence inside
 * it -- rather than model them. A refusal costs a reported gap; a wrong
 * acceptance costs a run that never returns.
 */

const MAX_CODE_POINT = 0x10ffff

/** Thrown internally to abandon the analysis with a reason a person can read. */
class Unsupported extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

/* -- character sets ------------------------------------------------------- */

/**
 * A set of code points as sorted, disjoint ranges.
 *
 * `exact` records whether the ranges are the set or merely contain it. An
 * over-approximation is safe for the only question asked of these sets -- can
 * two of them match the same character -- because a false "yes" refuses a
 * pattern and a false "no" would run one. Complementing an over-approximation
 * would invert that safety, so it widens to everything instead.
 */
function ranges(list, exact = true) {
  const sorted = list.filter(([low, high]) => low <= high).sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && low <= last[1] + 1) last[1] = Math.max(last[1], high)
    else merged.push([low, high])
  }
  return { ranges: merged, exact }
}

const EMPTY = ranges([])
const UNIVERSAL = ranges([[0, MAX_CODE_POINT]], false)

function single(codePoint) {
  return ranges([[codePoint, codePoint]])
}

function union(left, right) {
  return ranges([...left.ranges, ...right.ranges], left.exact && right.exact)
}

function complement(set) {
  if (!set.exact) return UNIVERSAL
  const out = []
  let next = 0
  for (const [low, high] of set.ranges) {
    if (low > next) out.push([next, low - 1])
    next = Math.max(next, high + 1)
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT])
  return ranges(out)
}

export function intersects(left, right) {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.ranges.length && rightIndex < right.ranges.length) {
    const [leftLow, leftHigh] = left.ranges[leftIndex]
    const [rightLow, rightHigh] = right.ranges[rightIndex]
    if (leftHigh < rightLow) leftIndex += 1
    else if (rightHigh < leftLow) rightIndex += 1
    else return true
  }
  return false
}

const DIGIT = ranges([[0x30, 0x39]])
const WORD = ranges([[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]])
const SPACE = ranges([
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
])
/** `.` without the `s` flag: everything except the four line terminators. */
const DOT = complement(ranges([[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]]))

const SIMPLE_ESCAPES = new Map([
  ['n', 0x0a], ['r', 0x0d], ['t', 0x09], ['f', 0x0c], ['v', 0x0b], ['0', 0x00],
])
const IDENTITY_ESCAPES = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/', '-'])

/* -- the parser ------------------------------------------------------------ */

/**
 * Parse the source into alternations of concatenations of quantified atoms.
 *
 * The source has already been accepted by `new RegExp(source, 'u')`, so this is
 * not a validator. Anything it does not recognise is a construct the analysis
 * below cannot reason about, and it is refused rather than skipped.
 */
function parseAlternation(state) {
  const branches = [parseConcat(state)]
  while (state.source[state.index] === '|') {
    state.index += 1
    branches.push(parseConcat(state))
  }
  const minimum = Math.min(...branches.map((branch) => branch.min))
  const maximum = Math.max(...branches.map((branch) => branch.max))
  let chars = EMPTY
  for (const branch of branches) chars = union(chars, branch.chars)
  return {
    branches,
    chars,
    min: minimum,
    max: maximum,
    /** A single branch of plain atoms: the only body a quantifier may be applied to. */
    plain: branches.length === 1 && branches[0].plain,
  }
}

function parseConcat(state) {
  const terms = []
  while (state.index < state.source.length && state.source[state.index] !== '|' && state.source[state.index] !== ')') {
    const term = parseTerm(state)
    // An unquantified group of one branch constrains nothing on its own, so its
    // terms join the sequence around it. Without this, `a*(?:a*)` would look
    // like two unrelated sequences and its competing quantifiers would be missed.
    if (term.kind === 'group' && term.transparent) terms.push(...term.node.branches[0].terms)
    else terms.push(term)
  }
  let minimum = 0
  let maximum = 0
  let chars = EMPTY
  let plain = true
  for (const term of terms) {
    minimum += term.min
    maximum += term.max
    chars = union(chars, term.chars)
    if (!term.plain) plain = false
  }
  return { terms, chars, min: minimum, max: maximum, plain }
}

function parseTerm(state) {
  const atom = parseAtom(state)
  const quantifier = parseQuantifier(state)

  if (atom.kind === 'anchor') {
    if (quantifier !== null) throw new Unsupported('syntax')
    return { kind: 'anchor', anchor: atom.anchor, chars: EMPTY, min: 0, max: 0, variable: false, plain: true }
  }

  const atomMin = atom.kind === 'group' ? atom.node.min : 1
  const atomMax = atom.kind === 'group' ? atom.node.max : 1

  if (quantifier === null) {
    if (atom.kind === 'group') {
      return {
        kind: 'group',
        node: atom.node,
        chars: atom.node.chars,
        min: atomMin,
        max: atomMax,
        variable: atomMin !== atomMax,
        plain: atom.node.plain,
        transparent: atom.node.branches.length === 1,
      }
    }
    return { kind: 'chars', chars: atom.chars, min: 1, max: 1, variable: false, plain: true }
  }

  if (atom.kind === 'group') {
    /**
     * A quantified group is the classic catastrophic shape as soon as its body
     * can match one input in more than one way: `(a+)+` and `(a|b)*` are
     * refused here whatever their contents happen to mean. A fixed sequence --
     * `(?:abc)+` -- decomposes one way only, so it is bounded and allowed.
     */
    if (!atom.node.plain) throw new Unsupported('quantified-group')
    if (atom.node.min === 0) throw new Unsupported('quantified-group')
  }

  const min = atomMin * quantifier.min
  const max = atomMax === 0 || quantifier.max === 0 ? 0 : atomMax * quantifier.max
  return {
    kind: atom.kind,
    node: atom.node,
    chars: atom.kind === 'group' ? atom.node.chars : atom.chars,
    min,
    max,
    variable: min !== max,
    plain: false,
  }
}

function parseQuantifier(state) {
  const character = state.source[state.index]
  const lazy = () => {
    if (state.source[state.index] === '?') state.index += 1
  }
  if (character === '*') {
    state.index += 1
    lazy()
    return { min: 0, max: Infinity }
  }
  if (character === '+') {
    state.index += 1
    lazy()
    return { min: 1, max: Infinity }
  }
  if (character === '?') {
    state.index += 1
    lazy()
    return { min: 0, max: 1 }
  }
  if (character === '{') {
    const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(state.source.slice(state.index))
    if (match === null) throw new Unsupported('syntax')
    state.index += match[0].length
    lazy()
    const min = Number(match[1])
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3])
    if (max < min) throw new Unsupported('syntax')
    return { min, max }
  }
  return null
}

function parseAtom(state) {
  const character = state.source[state.index]
  if (character === undefined) throw new Unsupported('syntax')
  if (character === '^' || character === '$') {
    state.index += 1
    return { kind: 'anchor', anchor: character }
  }
  if (character === '(') return parseGroup(state)
  if (character === '[') return { kind: 'chars', chars: parseClass(state) }
  if (character === '.') {
    state.index += 1
    return { kind: 'chars', chars: DOT }
  }
  if (character === '\\') return parseEscape(state, false)
  if ('*+?{}])|'.includes(character)) throw new Unsupported('syntax')
  const codePoint = state.source.codePointAt(state.index)
  state.index += String.fromCodePoint(codePoint).length
  return { kind: 'chars', chars: single(codePoint) }
}

function parseGroup(state) {
  state.index += 1
  if (state.source[state.index] === '?') {
    const rest = state.source.slice(state.index)
    // A lookaround re-matches its body at every position it is tried at, which
    // is a cost this analysis does not model, so it is declared unsupported.
    if (/^\?(?:=|!|<=|<!)/.test(rest)) throw new Unsupported('lookaround')
    const named = /^\?<[A-Za-z0-9_$]+>/.exec(rest)
    if (rest.startsWith('?:')) state.index += 2
    else if (named !== null) state.index += named[0].length
    else throw new Unsupported('syntax')
  }
  const node = parseAlternation(state)
  if (state.source[state.index] !== ')') throw new Unsupported('syntax')
  state.index += 1
  return { kind: 'group', node }
}

function parseClass(state) {
  state.index += 1
  let negated = false
  if (state.source[state.index] === '^') {
    negated = true
    state.index += 1
  }
  let chars = EMPTY
  while (state.source[state.index] !== ']') {
    if (state.index >= state.source.length) throw new Unsupported('syntax')
    const member = parseClassMember(state)
    const dash = state.source[state.index] === '-' && state.source[state.index + 1] !== ']' && state.index + 1 < state.source.length
    if (member.codePoint !== null && dash) {
      state.index += 1
      const upper = parseClassMember(state)
      if (upper.codePoint === null || upper.codePoint < member.codePoint) throw new Unsupported('syntax')
      chars = union(chars, ranges([[member.codePoint, upper.codePoint]]))
      continue
    }
    chars = union(chars, member.chars)
  }
  state.index += 1
  return negated ? complement(chars) : chars
}

function parseClassMember(state) {
  if (state.source[state.index] === '\\') {
    const escape = parseEscape(state, true)
    return { chars: escape.chars, codePoint: escape.codePoint ?? null }
  }
  const codePoint = state.source.codePointAt(state.index)
  state.index += String.fromCodePoint(codePoint).length
  return { chars: single(codePoint), codePoint }
}

function parseEscape(state, inClass) {
  const character = state.source[state.index + 1]
  if (character === undefined) throw new Unsupported('syntax')
  const literal = (codePoint, width) => {
    state.index += width
    return { kind: 'chars', chars: single(codePoint), codePoint }
  }

  if (!inClass && (character === 'b' || character === 'B')) {
    state.index += 2
    return { kind: 'anchor', anchor: character }
  }
  if (inClass && character === 'b') return literal(0x08, 2)
  if (character === 'd') return classEscape(state, DIGIT)
  if (character === 'D') return classEscape(state, complement(DIGIT))
  if (character === 'w') return classEscape(state, WORD)
  if (character === 'W') return classEscape(state, complement(WORD))
  if (character === 's') return classEscape(state, SPACE)
  if (character === 'S') return classEscape(state, complement(SPACE))
  if (character === 'p' || character === 'P') {
    const match = /^\\[pP]\{[^}]*\}/.exec(state.source.slice(state.index))
    if (match === null) throw new Unsupported('syntax')
    state.index += match[0].length
    // A Unicode property is not expanded here; it widens to everything, which
    // refuses it beside any other quantifier rather than guessing at its set.
    return { kind: 'chars', chars: UNIVERSAL }
  }
  // A backreference makes matching a search over earlier captures, which no
  // estimate here would bound.
  if (character === 'k') throw new Unsupported('backreference')
  if (!inClass && /[1-9]/.test(character)) throw new Unsupported('backreference')
  if (SIMPLE_ESCAPES.has(character)) {
    if (character === '0' && /[0-9]/.test(state.source[state.index + 2] ?? '')) throw new Unsupported('backreference')
    return literal(SIMPLE_ESCAPES.get(character), 2)
  }
  if (character === 'x') {
    const match = /^\\x([0-9a-fA-F]{2})/.exec(state.source.slice(state.index))
    if (match === null) throw new Unsupported('syntax')
    return literal(Number.parseInt(match[1], 16), match[0].length)
  }
  if (character === 'u') {
    const braced = /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(state.source.slice(state.index))
    if (braced !== null) return literal(Number.parseInt(braced[1], 16), braced[0].length)
    const match = /^\\u([0-9a-fA-F]{4})/.exec(state.source.slice(state.index))
    if (match === null) throw new Unsupported('syntax')
    return literal(Number.parseInt(match[1], 16), match[0].length)
  }
  if (character === 'c') {
    const match = /^\\c([A-Za-z])/.exec(state.source.slice(state.index))
    if (match === null) throw new Unsupported('syntax')
    return literal(match[1].toUpperCase().charCodeAt(0) - 64, match[0].length)
  }
  if (IDENTITY_ESCAPES.has(character)) return literal(character.codePointAt(0), 2)
  throw new Unsupported('syntax')
}

function classEscape(state, chars) {
  state.index += 2
  return { kind: 'chars', chars, codePoint: null }
}

/* -- the analysis ---------------------------------------------------------- */

/**
 * Walk one concatenation, refusing the shapes whose cost is not a function of
 * the subject length.
 *
 * `live` holds the character sets of the variable-length terms whose end is not
 * yet pinned. A second variable-length term that could match the same
 * characters is the ambiguity every catastrophic case is built from -- the
 * input can be split between them in as many ways as it has characters, and
 * with three such terms in as many ways as it has characters cubed -- so it is
 * refused. A fixed-length term that overlaps a live set does not multiply with
 * another quantifier, but it does make the engine retry: it is counted, and the
 * estimate pays a factor of the subject length for it. A fixed-length term that
 * overlaps nothing pins the position and clears the set.
 */
function analyseConcat(concat, counters) {
  const live = []
  for (const term of concat.terms) {
    if (term.kind === 'anchor') continue
    const overlapping = live.some((chars) => intersects(chars, term.chars))
    if (term.variable) {
      if (overlapping) throw new Unsupported('competing-quantifiers')
      counters.variable += 1
      live.push(term.chars)
    } else if (overlapping) {
      counters.overlaps += 1
    } else if (term.min > 0) {
      live.length = 0
    }
    if (term.kind === 'group') analyseNode(term.node, counters)
  }
}

function analyseNode(node, counters) {
  if (node.branches.length > 1) counters.paths *= node.branches.length
  for (const branch of node.branches) analyseConcat(branch, counters)
}

/** Every top-level branch starts at the start of the subject, so there is one start. */
function isAnchored(node) {
  return node.branches.every((branch) => branch.terms[0] !== undefined
    && branch.terms[0].kind === 'anchor' && branch.terms[0].anchor === '^')
}

/**
 * Decide whether this tool will run this pattern at all, and at what cost.
 *
 * Returns the shape facts the estimate is built from, or the name of the reason
 * the pattern is refused. The result depends on the pattern alone, so it is
 * cached per pattern source; the subject length enters only in
 * `estimatePatternWork`.
 */
export function analyzePattern(source) {
  try {
    const state = { source, index: 0 }
    const node = parseAlternation(state)
    if (state.index !== source.length) throw new Unsupported('syntax')
    const counters = { paths: 1, variable: 0, overlaps: 0 }
    analyseNode(node, counters)
    return {
      ok: true,
      anchored: isAnchored(node),
      paths: counters.paths,
      variable: counters.variable,
      overlaps: counters.overlaps,
    }
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.reason }
    throw error
  }
}

/**
 * An upper-bound estimate of the work matching this subject would cost.
 *
 * Every factor is a count of something the engine can be made to repeat: the
 * positions a match may start at, the alternation branches it may try, the
 * variable-length terms it may give characters back to, and the length of the
 * subject each of those walks. It is an over-estimate by design -- an anchored
 * `^.*x$` is linear and is charged as if it were quadratic -- because the point
 * is to refuse before running, and a refusal is reported while a wrong
 * acceptance is not.
 */
export function estimatePatternWork(analysis, length) {
  const span = length + 1
  const starts = analysis.anchored ? 1 : span
  return starts * analysis.paths * Math.max(1, analysis.variable) * span ** (analysis.overlaps + 1)
}

/** Why a pattern was refused, in the words the finding uses. */
export const REFUSAL_REASONS = Object.freeze({
  'quantified-group': 'quantifies a group that is not a fixed sequence of characters',
  'competing-quantifiers': 'applies two quantifiers that compete for the same characters',
  lookaround: 'uses lookahead or lookbehind',
  backreference: 'uses a backreference',
  syntax: 'uses a construct this tool does not model',
})
