# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking
change and is recorded here.

## [Unreleased]

### Added

- `analyzeOpenApi` and `validateOpenApiFile` check every request and response
  example in an OpenAPI 3.0 or 3.1 description against the schema declared for
  its own media type under its own operation, and return the report.
- `openapi-example-validator` command line interface with `--spec`, `--json`,
  `--help` and the eleven documented limit flags.
- Example positions covered: request bodies, responses, response headers, and
  path- and operation-level parameters; both `example` and `examples`, including
  an Example Object reached through a `$ref`. Declaring `example` and `examples`
  together is reported and both are still checked.
- Media-type-directed validation: JSON media types (`application/json` and any
  `+json` suffix) carry a structured value, `text/plain` carries a string, and
  every other media type is reported as unmodelled rather than validated as if it
  were JSON.
- Bounded local reference resolution. A remote or protocol-relative `$ref` is
  refused and never fetched; a reference into another file is refused as
  unsupported; an anchor fragment and a `$ref` carrying forbidden siblings are
  refused as malformed; a chain that returns to a node it already visited is
  written out -- rooted at its code-unit-smallest member -- and not followed.
  Cycles that travel through a keyword rather than through `$ref` alone are
  caught too, which is what makes a genuinely recursive schema safe to validate.
- A declared schema subset: which keywords are asserted, which are annotations,
  and which are reported as unsupported. An unsupported keyword, an unsupported
  `$schema` or `jsonSchemaDialect`, or an unmodelled media type makes the run
  `incomplete`; an example under one can still fail but can never pass.
- `pattern` compiled in Unicode mode, with patterns whose matching cost cannot be
  bounded -- a quantified group containing a quantifier or an alternation --
  refused as unsupported rather than run.
- `format` asserted for `date`, `date-time` and `uuid`, checked arithmetically
  rather than through `Date`; every other format recorded as an `info` finding
  saying it was not asserted.
- Exact JSON Pointers: every finding names a position that runs through the
  operation, the media type and the example and then into the example value.
- Forty-eight rules with severities in one frozen table and pinned behaviourally
  through the real command line, documented in `docs/example-rules.md`.
- Eleven explicit limits -- bytes, document depth, traversal nodes, operations,
  examples, example bytes, example depth, reference depth, evaluation depth,
  pattern length and milliseconds -- each enforced, each wired to a flag, each
  reported by name, and each refusing whole rather than truncating.
- Stable output: no clock reading, no randomness, no absolute host path, no
  locale-dependent ordering, and byte-identical stdout for the same bytes.

No release has been published.
