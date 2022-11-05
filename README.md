# openapi-example-validator

Check every request and response example in an OpenAPI description against the
schema that actually governs it -- the schema declared for **that media type**,
under **that operation** -- and say plainly which examples could not be checked
at all.

- **Repository:** [edilec/openapi-example-validator](https://github.com/edilec/openapi-example-validator)
- **Area:** API & Integration
- **License:** MIT

Zero dependencies, runtime and development both. Node built-ins only, Node 22 or
newer. No network access of any kind: a `$ref` that names a remote document is
refused, never fetched.

## Why it exists

An example in an API description is the first thing a reader copies and the last
thing anyone validates. It drifts: a field is renamed in the schema and left
alone in the example, a status enum gains a value the example never had, a
`text/plain` body is illustrated with a JSON object. None of that breaks a build,
and all of it breaks whoever trusted the example.

The failure this tool is built against is subtler than the drift itself. A
validator that walks past a `$ref` it cannot follow, a keyword it does not model
or a media type it does not understand, and then reports `pass`, has not checked
the examples -- it has declared victory. Every such gap here is a finding, and
every such finding makes the run `incomplete`, which is neither a pass nor a
fail: it says the evidence for one was not obtained.

## Install

```sh
npm install openapi-example-validator
```

Or run it without installing:

```sh
npx openapi-example-validator --spec openapi.json
```

## Use

```sh
openapi-example-validator --spec examples/petstore.json
```

```
openapi 3.1.0 "Pet store": 7 of 7 example(s) checked across 2 operation(s), 0 error, 0 warning, 0 info, 0 unanswered, status pass.
```

```sh
openapi-example-validator --spec examples/broken-petstore.json
```

```
openapi 3.1.0 "Pet store (broken examples)": 6 of 7 example(s) checked across 2 operation(s), 11 error, 0 warning, 0 info, 0 unanswered, status fail.
ERROR   examples/broken-petstore.json/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/0/birthday example-format-invalid The example at /items/0/birthday is not a valid "date".
ERROR   examples/broken-petstore.json/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/0/nickname example-additional-property The example at /items/0 declares "nickname", which the schema does not declare and "additionalProperties": false forbids.
ERROR   examples/broken-petstore.json/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/0/status example-required-missing The example at /items/0 does not declare the required property "status".
ERROR   examples/broken-petstore.json/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/0/tags/1 example-duplicate-items The example at /items/0/tags/1 repeats the item at index 0, but the schema declares "uniqueItems".
ERROR   examples/broken-petstore.json/paths/~1pets/get/responses/200/content/application~1json/examples/two-pets/value/items/1/id example-type-mismatch The example at /items/1/id is string, but the schema declares integer.
...
```

The pointer is the point. It runs through the operation, the media type and the
named example, and then continues into the example value itself, so an invalid
field four levels inside a nested example has an address rather than a
description.

A third example shows the shape of a run that is not a verdict:

```sh
openapi-example-validator --spec examples/unresolvable.json
```

```
openapi 3.1.0 "Pet store (questions this tool cannot answer)": 0 of 3 example(s) checked across 2 operation(s), 4 error, 3 warning, 0 info, 7 unanswered, status incomplete.
```

Add `--json` for the machine-readable report. `--help` lists every option and
every limit.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every example that could be checked agreed with its schema |
| `1` | at least one example contradicts the schema that governs it |
| `2` | invalid usage or configuration (stdout is **empty**), or evidence that was missing, unreadable or bounded out (stdout carries an `incomplete` report) |

stdout carries the report and nothing else; diagnostics go to stderr, so a
non-empty stderr on a successful run is correct.

## As a library

```js
import { validateOpenApiFile } from 'openapi-example-validator'

const { report } = await validateOpenApiFile('openapi.json', { source: 'openapi.json' })
if (report.status !== 'pass') {
  for (const finding of report.findings) {
    console.error(`${finding.severity} ${finding.location.pointer} ${finding.message}`)
  }
}
```

`analyzeOpenApi({ bytes, source, limits, clock })` is the same analysis over
bytes you already hold. Both return `{ report, version, title }`.

## What it checks

| | |
| --- | --- |
| Example positions | request bodies, responses, response headers, and path- and operation-level parameters |
| Schema selection | per media type, so two examples under one operation are checked against two schemas |
| References | same-document `$ref` only, with cycles named rather than followed |
| Schema subset | `type`, `enum`, `const`, `format`, numeric bounds, string bounds, `pattern`, `items`, array bounds, `uniqueItems`, `required`, `properties`, `additionalProperties`, object bounds, `allOf`, `anyOf`, `oneOf`, plus `nullable` in 3.0 |
| Rules | 48, with severities in one frozen table and pinned behaviourally |
| Gaps | 32 rules, every one of which makes the run `incomplete` |
| Limits | 11, each enforced, each wired to a flag, each reported by name |

`docs/example-rules.md` is the full catalog: every rule, every limit, and the
exact list of which schema keywords are asserted, which are annotations, and
which are refused.

## Limits and non-goals

This section is the honest part of the README. These are the things the tool
**cannot** conclude, whatever its exit code says.

- **It cannot tell you an example is valid when it reported `incomplete`.** That
  status means a schema was not fully evaluated, a reference was not followed, a
  media type was not modelled, or a limit was reached. A `pass` is a statement
  about the examples; an `incomplete` is a statement about the run.
- **It does not read YAML.** A YAML parser is a dependency and hand-rolling one
  is a defect surface unrelated to examples. A non-JSON description is reported
  as `document-not-json` and the run is incomplete. Convert first.
- **It reads exactly one file.** A `$ref` into another file is refused as
  unsupported, not resolved. A multi-file description therefore cannot be fully
  checked by this tool, and it will say so rather than check the parts it can and
  call that a pass.
- **It never fetches anything.** A remote `$ref` and an Example Object's
  `externalValue` are both refused. This is not a configuration option.
- **It implements a subset of JSON Schema, not JSON Schema.** `not`,
  `if`/`then`/`else`, `patternProperties`, `prefixItems`, `contains`,
  `dependentSchemas`, `unevaluatedProperties`, `$id`, `$anchor` and
  `$dynamicRef` are all reported as unsupported. An example under a schema that
  uses one of them can still be shown to *fail*, but it can never be shown to
  pass.
- **`format` is asserted for `date`, `date-time` and `uuid` only.** Every other
  format produces an `info` finding saying so. It does not mean the value is
  well-formed; it means nothing checked.
- **It does not validate the description against the OpenAPI meta-schema.** A
  description can be structurally wrong in ways this tool walks past, because its
  subject is the examples. Use a linter for the description itself.
- **It does not model serialisation.** Form encoding, multipart, XML and binary
  media types are refused rather than validated as if they were JSON, because
  their serialisation rules decide what a schema even means for them.
- **`multipleOf` on non-integers is compared within a tolerance of `1e-9`.** A
  value that is a multiple only within that tolerance is reported as satisfying
  the keyword.
- **A `pattern` that quantifies a group containing a quantifier or an
  alternation is refused**, not applied -- deliberately conservative, because
  telling `(a|b)+` apart from `(a|a)+` means answering the question the refusal
  exists to avoid.
- **It checks examples, not implementations.** Nothing is executed, no request is
  made, and an example that agrees with its schema says nothing about whether the
  service would ever produce it.
- **Sanitising is lossy on purpose.** Control and bidi characters in an
  identifier are replaced before it reaches output, so two keys that differ only
  in such characters can appear identical in a report. That is the trade against
  a report line that lies about its own structure.

## Determinism

Running the tool twice over the same bytes produces byte-identical stdout.
Findings sort by `(location.pointer, ruleId, declaration order)` compared by
UTF-16 code unit -- never by `localeCompare` or `Intl.Collator`, both of which
consult ICU data that differs between Node builds. No wall clock, no randomness,
no absolute host path, and no dependence on the order the description happened to
be written in.

## Verify

```sh
npm run check
```

That runs `node --check` over every file, the whole test suite, the worked
example, and `npm pack --dry-run`.

## License

MIT. See [LICENSE](./LICENSE).
