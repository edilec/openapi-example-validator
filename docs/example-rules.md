# What is checked, what is refused, and what is bounded

This tool reads one OpenAPI description, follows the local references it needs,
and checks every request and response example against the schema that governs
it. It executes nothing, fetches nothing, and writes nothing.

The important part of this document is not the list of what it checks. It is the
list of what it refuses to conclude.

## The subject

A single JSON file, named with `--spec`. OpenAPI 3.0.x and 3.1.x are modelled;
any other `openapi` value is refused rather than guessed at, because the two
minor versions spell nullability and exclusive bounds differently and validating
one with the other's rules would invent failures and miss real ones.

YAML is not read. A YAML parser is a dependency, and hand-rolling one is a
defect surface with nothing to do with examples, so `document-not-json` says so
and the run is incomplete. Convert the description to JSON first.

## Where examples are looked for

| Position | Schema used |
| --- | --- |
| `paths.{path}.{method}.requestBody.content.{mediaType}` | that media type's `schema` |
| `paths.{path}.{method}.responses.{status}.content.{mediaType}` | that media type's `schema` |
| `paths.{path}.{method}.responses.{status}.headers.{name}` | the header's `schema`, or its `content` |
| `paths.{path}.parameters[i]` and `paths.{path}.{method}.parameters[i]` | the parameter's `schema`, or its `content` |

Path-level parameters are examined once per path item, not once per operation,
so a mistake in a shared parameter is reported once rather than eight times.

At each of those positions both `example` and `examples` are read. Declaring
both is `example-declaration-conflict` -- and then both are checked anyway,
because refusing to look would turn a declaration mistake into an unexamined
payload. An Example Object with `externalValue` is reported and never fetched.

## The media type decides the schema

Two examples under one operation are checked against two different schemas when
they sit under two different media types. The media type also decides how the
example value is read:

| Media type | How the example is read |
| --- | --- |
| `application/json`, any `*/*+json` | a structured JSON value, checked against the schema directly |
| `text/plain` | a string; an example that is not a string is `example-not-text` |
| anything else | `media-type-unsupported`; the examples under it are not checked |

A `charset` parameter other than UTF-8 makes the media type unsupported, because
the payload it describes is not the one the example shows.

Form encoding, multipart, XML and `application/octet-stream` are refused rather
than validated as if they were JSON. Their serialisation rules decide what a
schema even means for them, and this tool does not model those rules.

## References

Only a same-document reference is resolved: a `$ref` whose value is a fragment,
`#/components/schemas/Pet`. Everything else is refused by name:

- a URI scheme or a protocol-relative reference is `ref-remote-refused`;
  **nothing is fetched, ever**, and no socket is opened;
- a reference into another file is `ref-external-file-unsupported`; this tool
  reads exactly one file, which is why it has no root to confine;
- an anchor fragment (`#Pet`) is `ref-malformed`; anchors are a different
  resolution mechanism and guessing at it would be worse than refusing;
- a `$ref` object carrying any sibling other than `summary` and `description` is
  `ref-malformed`, because silently ignoring the sibling is how a constraint
  disappears.

A chain that returns to a pointer it already visited is `ref-cycle`: it is
written out -- rooted at its code-unit-smallest member so two runs describe it
identically -- and not followed. This catches both the bare loop
(`Loop -> Mirror -> Loop`) and the loop that travels through a keyword
(`A.allOf[0] -> B`, `B.allOf[0] -> A`), which the resolver alone would not see.

A **recursive** schema is not a cycle. `Node.properties.child -> Node` consumes
a level of the example at every hop, so it terminates, and it is validated
normally; only a cycle that consumes nothing is refused.

## The schema subset

Every keyword falls into exactly one of three sets. The third is the honest one.

**Asserted** -- modelled, and a violation is a finding:

`$ref`, `type`, `enum`, `format`, `multipleOf`, `maximum`, `exclusiveMaximum`,
`minimum`, `exclusiveMinimum`, `maxLength`, `minLength`, `pattern`, `items`,
`maxItems`, `minItems`, `uniqueItems`, `required`, `properties`,
`additionalProperties`, `maxProperties`, `minProperties`, `allOf`, `anyOf`,
`oneOf`; plus `nullable` in 3.0, and `const` and `$schema` in 3.1.

**Annotations** -- they constrain nothing, so ignoring them is what the
specification says to do:

`title`, `description`, `default`, `example`, `examples`, `deprecated`,
`readOnly`, `writeOnly`, `externalDocs`, `xml`, `discriminator`, `$comment`,
`$defs`, `definitions`.

**Everything else** is `schema-keyword-unsupported`, and the run is incomplete.
That includes `not`, `if`/`then`/`else`, `patternProperties`, `prefixItems`,
`contains`, `dependentSchemas`, `dependentRequired`, `unevaluatedProperties`,
`unevaluatedItems`, `$id`, `$anchor`, `$dynamicRef`, and any vendor extension
that is not one of the above.

An example under a schema carrying an unsupported keyword can still **fail**:
JSON Schema is conjunctive, so no unevaluated keyword can rescue a value that
already contradicts an evaluated one. It can never **pass**.

### Dialects

In 3.1, `$schema` and the document's `jsonSchemaDialect` may name only
`https://json-schema.org/draft/2020-12/schema`. Any other value is
`schema-dialect-unsupported`. In 3.0 neither key is allowed at all, and
declaring one is the same finding: a 3.0 Schema Object is not a JSON Schema
document and a dialect declared on it changes what its keywords mean.

### Boolean schemas

`true` and `false` as whole schemas are not modelled; they are reported as
`schema-malformed`.

### Formats

Three formats are asserted: `date`, `date-time` and `uuid`. Dates are
range-checked arithmetically rather than through `Date`, because
`new Date('2024-02-30T00:00:00Z')` does not throw -- it rolls over into March,
so a check built on it accepts a day that does not exist.

Every other `format` produces one `format-not-asserted` finding, at `info`
severity. In JSON Schema `format` is an annotation unless a dialect says
otherwise, so not asserting `email` or `int64` is conformant -- but leaving that
silent would let a reader believe it had been checked. The finding is the
record that it was not.

### `pattern`

A `pattern` comes out of an untrusted description, and a regular expression
match cannot be interrupted: the engine does not yield, so `maxMillis` is never
consulted while one runs. A deadline checked around the call cannot fire during
it. The cost is therefore decided **before** the match starts, and a match whose
cost this tool will not take is refused and reported as
`schema-pattern-unsupported` -- which makes the run `incomplete`, never a pass.

A pattern is applied only when both of these hold.

**1. The pattern is inside the declared subset.** It is compiled with the
Unicode flag and then parsed. These are refused:

- a pattern longer than `maxPatternLength`;
- a quantifier applied to a group that is not a fixed sequence of characters --
  `(a+)+`, `(a|b)*`, `(?:-[a-z]+)*`. `(?:abc)+` is a fixed sequence and is
  allowed;
- two quantifiers that compete for the same characters -- `a*a*`, `\d*\d*`,
  `[a-z]*[a-z]*`, `a*b?a*`. This is the shape a group is not needed for, and
  the shape an earlier version of this check let through: `^a*a*a*a*a*a*a*a*a*a*$`
  against thirty `a`s and a `b` ran for 6.8 seconds under a declared
  100-millisecond budget;
- lookahead or lookbehind, a backreference, or any construct the parser does not
  model.

The subset is deliberately conservative, and the refusals above are not a
complete theory of catastrophic backtracking -- they are the shapes this tool
will vouch for. `^(a|b)+$` is harmless and is still refused, because telling it
apart from `^(a|a)+$` means answering the question the refusal exists to avoid.

**2. This subject is affordable.** Even an unambiguous pattern is quadratic in
the length of the subject when it is unanchored, because the engine retries at
every starting position: `[a-z]*1` against 65,000 letters takes two seconds. So
before each match an upper-bound estimate is computed from four counts, each of
something the engine can be made to repeat --

- the positions the match may start at: one if the pattern is anchored with
  `^`, otherwise the subject length;
- the alternation branches it may try;
- the variable-length terms it may give characters back to;
- the subject length, once for the walk itself and once more for every
  fixed-length term that overlaps a quantifier in front of it and therefore
  makes the engine retry

-- and compared against `maxPatternSteps`. Over it, that match is not run and
that example is reported as unchecked. Anchoring a pattern with `^` collapses
the starting positions to one, which is why an anchored pattern is affordable
against a subject an unanchored one is not.

The estimate is an over-estimate by design: an anchored `^.*x$` is linear and is
charged as though it were quadratic. Refusing a match that would have been quick
costs a reported gap; running one that never returns costs the run.

### `multipleOf`

`0.3 % 0.1` is `0.09999999999999998` in binary floating point, so a plain modulo
reports a violation that is not there. Integers are compared exactly; other
numbers are compared against the nearest integer ratio within a relative
tolerance of `1e-9`. A value that is a multiple only within that tolerance is
reported as satisfying the keyword.

### `anyOf` and `oneOf`

Each branch is evaluated. A losing branch's complaints about the example are
discarded -- only the aggregate is reported -- but a branch that could not be
*evaluated* is different: its structural problem always surfaces, and it also
suppresses the aggregate. "None of these branches matched" would be an
accusation this tool has not earned when one branch was never evaluated.

## The rule catalog

Forty-eight rules. `ruleId` is part of the public interface: renaming one is a
breaking change and is recorded in the changelog. Severity comes from one frozen
table in `src/index.mjs` and from nowhere else, and an unknown rule id throws
rather than defaulting.

"Incomplete" means the rule marks the whole run `incomplete`. Thirty-two do.
Three of those are `warning` severity, which means the incompleteness is the
only thing between them and a green build; each has a test that fails when that
membership is removed.

| Rule | Severity | Incomplete | What it means |
| --- | --- | --- | --- |
| `document-malformed` | error | yes | The bytes parsed, but the result is not an OpenAPI object, or `paths` is not an object. |
| `document-not-json` | error | yes | The bytes decoded but are not JSON. This tool reads JSON only; YAML is a non-goal. The evidence carries the parser's position, line and column, never the snippet of the file the parser quotes back: V8 reports `Unexpected token 'A', "..." is not valid JSON`, which reproduces a short description in full. |
| `document-not-utf8` | error | yes | The bytes are not valid UTF-8, so no part of the description was read. |
| `document-too-deep` | error | yes | The description nests deeper than `maxDepth`, so it was not walked. |
| `document-too-large` | error | yes | The file is larger than `maxBytes`, so it was not parsed. |
| `document-unreadable` | error | yes | The file could not be opened. |
| `example-additional-property` | error | no | The example carries a property the schema does not declare, under `additionalProperties: false`. |
| `example-any-of-unsatisfied` | error | no | The example satisfies none of the `anyOf` branches. |
| `example-const-mismatch` | error | no | The example is not the single value `const` declares (OpenAPI 3.1 only). |
| `example-declaration-conflict` | error | no | One object declares both `example` and `examples`, which OpenAPI forbids. Both are still checked. |
| `example-duplicate-items` | error | no | An array repeats an item although the schema declares `uniqueItems`. |
| `example-enum-mismatch` | error | no | The example is not one of the values `enum` lists. |
| `example-external-value` | warning | yes | The example's value lives in another document. Nothing is fetched, so the value was never obtained. |
| `example-format-invalid` | error | no | The example violates an asserted `format`: `date`, `date-time` or `uuid`. |
| `example-length-invalid` | error | no | A string, array or object is outside `minLength`/`maxLength`, `minItems`/`maxItems` or `minProperties`/`maxProperties`. |
| `example-not-text` | error | no | An example under a text media type is not a string, so it cannot be the payload it describes. |
| `example-one-of-ambiguous` | error | no | The example satisfies more than one `oneOf` branch, and `oneOf` admits exactly one. |
| `example-one-of-unsatisfied` | error | no | The example satisfies none of the `oneOf` branches. |
| `example-out-of-range` | error | no | A number violates `minimum`, `maximum`, an exclusive bound or `multipleOf`. |
| `example-pattern-mismatch` | error | no | A string does not match the declared `pattern`. |
| `example-required-missing` | error | no | The example omits a property the schema declares in `required`. |
| `example-too-deep` | error | yes | One example nests deeper than `maxExampleDepth`. It was refused whole, not walked half way. |
| `example-too-large` | error | yes | One example serialises to more than `maxExampleBytes`. It was refused whole. |
| `example-type-mismatch` | error | no | The example's JSON type is not one the schema declares. |
| `format-not-asserted` | info | no | A `format` outside the asserted set. It constrains nothing here, and this finding is the record that no example was checked against it. |
| `media-type-unsupported` | error | yes | The content key is not a media type this tool models, so the examples under it were not checked. |
| `no-examples-declared` | warning | yes | The run checked no example against any schema, so it is evidence of nothing. |
| `node-budget-exceeded` | error | yes | The traversal and evaluation budget `maxNodes` was spent before the walk finished. |
| `openapi-version-missing` | error | yes | The description declares no `openapi` member, so the dialect of its schemas is unknown. |
| `openapi-version-unsupported` | error | yes | The declared version is outside 3.0.x and 3.1.x. |
| `operation-malformed` | error | yes | A node in the `paths` tree is not the shape OpenAPI requires. Nothing under it was examined. |
| `ref-cycle` | error | yes | A reference chain returns to a node it already visited, directly or through a keyword. |
| `ref-depth-exceeded` | error | yes | A reference chain is longer than `maxRefDepth`. |
| `ref-external-file-unsupported` | error | yes | A reference names another file. This tool reads exactly one document. |
| `ref-malformed` | error | yes | A `$ref` is not a string, is empty, is an anchor rather than a pointer, is badly escaped, or carries a sibling other than `summary` and `description`. |
| `ref-remote-refused` | error | yes | A reference carries a URI scheme or is protocol-relative. Nothing is fetched. |
| `ref-unresolved` | error | yes | A local reference names a position the description does not contain. |
| `schema-dialect-unsupported` | error | yes | `$schema` or `jsonSchemaDialect` names a dialect this tool does not model, or appears in a 3.0 document where it may not. |
| `schema-keyword-unsupported` | error | yes | A schema keyword outside the modelled subset. The example under it can still fail, but it can never pass. |
| `schema-malformed` | error | yes | A schema, or the value of one of its keywords, is not the shape that keyword requires. |
| `schema-missing` | warning | yes | Examples are declared with no schema beside them, so there was nothing to check them against. |
| `schema-pattern-invalid` | error | yes | A `pattern` is not a valid Unicode-mode regular expression, so it was not compiled. |
| `schema-pattern-unsupported` | error | yes | A `pattern` is longer than `maxPatternLength`, is outside the subset this tool bounds, or would cost more than `maxPatternSteps` against this example. |
| `schema-too-deep` | error | yes | Schema evaluation passed `maxEvalDepth`. |
| `schema-type-invalid` | error | yes | A `type` this tool does not recognise, or a list of types in an OpenAPI 3.0 schema. |
| `time-budget-exceeded` | error | yes | The run passed the `maxMillis` budget. |
| `too-many-examples` | error | yes | The description declares more examples than `maxExamples`. |
| `too-many-operations` | error | yes | The description declares more operations than `maxOperations`. |

## The limits

Every limit is enforced, wired to a flag, and reported by name when it is
reached. What exceeded a limit is refused whole: a document-level limit refuses
the document, an example-level limit refuses that example. Nothing is truncated,
and no limit can turn into a silent pass.

| Limit | Flag | Default | What it bounds |
| --- | --- | ---: | --- |
| `maxBytes` | `--max-bytes` | 2097152 | the size of the description on disk |
| `maxDepth` | `--max-depth` | 40 | JSON nesting inside the description |
| `maxNodes` | `--max-nodes` | 200000 | document nodes walked plus example nodes evaluated |
| `maxOperations` | `--max-operations` | 500 | operations examined |
| `maxExamples` | `--max-examples` | 2000 | examples examined |
| `maxExampleBytes` | `--max-example-bytes` | 65536 | the serialised size of one example |
| `maxExampleDepth` | `--max-example-depth` | 24 | nesting inside one example |
| `maxRefDepth` | `--max-ref-depth` | 16 | the length of one `$ref` chain |
| `maxEvalDepth` | `--max-eval-depth` | 512 | schema evaluation depth |
| `maxPatternLength` | `--max-pattern-length` | 200 | the source length of one `pattern` |
| `maxPatternSteps` | `--max-pattern-steps` | 20000000 | the estimated work of one `pattern` match |
| `maxMillis` | `--max-millis` | 5000 | the whole run, measured with an injected clock |

`maxMillis` is checked between steps, not during one: the walk stops at the
first check after the budget is spent, so the step in progress is finished
rather than interrupted. That is why the one step whose cost is not a function
of the description's size -- matching a `pattern` -- is bounded separately, by
`maxPatternSteps`, before it starts.

An unknown limit key is a configuration error, not a default: `maxExamplesBytes`
for `maxExampleBytes` would otherwise enforce the default while the caller
believed it had raised the bound.

## The report

The envelope follows the catalog's report contract:

```json
{
  "schemaVersion": "1",
  "tool": "openapi-example-validator",
  "status": "fail",
  "summary": { "checked": 6, "errors": 11, "warnings": 0, "info": 0, "operations": 2, "examples": 7, "unknown": 0 },
  "findings": []
}
```

- `checked` counts examples for which a schema was obtained **and fully
  applied**. An example whose schema carried an unsupported keyword, or whose
  reference was refused, is counted in `examples` and not in `checked`. That is
  why a description full of examples can honestly report `checked: 0`.
- `unknown` counts the findings that make the run incomplete.
- `status` is `incomplete` whenever any of those fired, and `incomplete` is never
  interchangeable with `pass`.

### Pointers

`location.pointer` is a JSON Pointer into the description. It runs through the
operation, the media type and the example, and then continues into the example
value, so an invalid field nested inside a nested example is addressable:

```
/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/1/id
```

When the example or the schema was reached through a `$ref`, the pointer names
the resolved position, not the referring one, because that is where the value
actually is.

### Ordering

Findings sort by `(location.pointer, ruleId, declaration order)`, compared by
UTF-16 code unit. `localeCompare` and `Intl.Collator` both consult ICU data that
differs between Node builds -- a collator puts `assets` before `README` and
orders `a_b` before `a-b` -- and a report that is diffed between machines cannot
depend on that. `location.file` is not a sort key: every finding in a run comes
from the one description, and a key that cannot discriminate is not a key.

### Sanitising

Every string that came out of the description is stripped of C0 (U+0000-U+001F),
DEL, C1 (U+0080-U+009F), U+2028, U+2029 and the bidi controls (U+200E, U+200F,
U+202A-U+202E, U+2066-U+2069) before it reaches output, and then bounded. This
applies to identifiers, not only to excerpts: a path template, a media type, an
example name, a property name, a `$ref` string and an unknown keyword are all
strings the document's author chose, and every one of them becomes a pointer
segment or part of a message.

Sanitising is not what defends the parse-failure path, because it cannot be.
V8 phrases one of its two JSON parse failures as `Unexpected token 'A', "..."
is not valid JSON`, quoting the input at the FRONT of the message, where a
strip of control characters does not reach it and a length bound that cuts
from the END never gets to it. The quotation is removed outright instead, and
the parser's position, line and column -- which carry no content -- are what
the evidence field keeps.

Because that is lossy, two identifiers that differ only in stripped characters
render identically. They are still two findings: repeats are recognised by the
position the description really named, before anything was stripped, so a real
offending position is never deleted by the one that renders like it, and the
error and unanswered counts are the counts of positions rather than of distinct
report lines.
