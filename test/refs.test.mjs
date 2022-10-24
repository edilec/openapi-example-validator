import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { classifyRef, createResolver, rotateCycle } from '../src/refs.mjs'

test('a reference is classified before anything tries to follow it', () => {
  assert.deepEqual(classifyRef('#/components/schemas/Pet'), { kind: 'local', parts: ['components', 'schemas', 'Pet'] })
  assert.deepEqual(classifyRef('#'), { kind: 'local', parts: [] })
  assert.equal(classifyRef('https://example.invalid/x.json').kind, 'remote')
  assert.equal(classifyRef('http://example.invalid/x.json').kind, 'remote')
  assert.equal(classifyRef('file:///etc/passwd').kind, 'remote')
  assert.equal(classifyRef('urn:example:pet').kind, 'remote')
  assert.equal(classifyRef('//example.invalid/x.json').kind, 'remote')
  assert.equal(classifyRef('./other.json#/Pet').kind, 'file')
  assert.equal(classifyRef('other.json').kind, 'file')
  assert.equal(classifyRef('#Pet').kind, 'malformed')
  assert.equal(classifyRef('').kind, 'malformed')
  assert.equal(classifyRef(7).kind, 'malformed')
})

test('a cycle is written from its code-unit-smallest member, whichever way it was entered', () => {
  // A rotation, not a sort: the cycle keeps its own direction and only its
  // starting point is pinned, so the same loop reads the same way every time.
  assert.deepEqual(rotateCycle(['/a', '/Z', '/README']), ['/README', '/a', '/Z'])
  assert.deepEqual(rotateCycle(['/Z', '/README', '/a']), ['/README', '/a', '/Z'])
  assert.deepEqual(rotateCycle(['/Z', '/a']), ['/Z', '/a'])
  assert.deepEqual(rotateCycle(['/only']), ['/only'])
})

const root = {
  components: {
    schemas: {
      Pet: { type: 'object' },
      Alias: { $ref: '#/components/schemas/Pet' },
      Chain: { $ref: '#/components/schemas/Alias' },
      Loop: { $ref: '#/components/schemas/Mirror' },
      Mirror: { $ref: '#/components/schemas/Loop' },
      Selfish: { $ref: '#/components/schemas/Selfish' },
    },
  },
}
const resolver = createResolver(root, DEFAULT_LIMITS)

test('a chain resolves to the node it names, and reports where that node lives', () => {
  const direct = resolver.resolve(root.components.schemas.Pet, ['components', 'schemas', 'Pet'])
  assert.deepEqual(direct, { ok: true, value: { type: 'object' }, parts: ['components', 'schemas', 'Pet'], hops: 0 })

  const chained = resolver.resolve({ $ref: '#/components/schemas/Chain' }, ['x'])
  assert.equal(chained.ok, true)
  assert.deepEqual(chained.value, { type: 'object' })
  assert.deepEqual(chained.parts, ['components', 'schemas', 'Pet'])
  assert.equal(chained.hops, 3)
})

test('a self-referencing component is caught on its first hop', () => {
  const result = resolver.resolve({ $ref: '#/components/schemas/Selfish' }, ['x'])
  assert.equal(result.ok, false)
  assert.equal(result.ruleId, 'ref-cycle')
  assert.equal(result.evidence, '/components/schemas/Selfish -> /components/schemas/Selfish')
})

test('a two-step cycle is named from its smallest member and not followed', () => {
  const result = resolver.resolve({ $ref: '#/components/schemas/Mirror' }, ['x'])
  assert.equal(result.ruleId, 'ref-cycle')
  assert.equal(result.evidence, '/components/schemas/Loop -> /components/schemas/Mirror -> /components/schemas/Loop')
})

test('a refusal names which kind of refusal it is', () => {
  assert.equal(resolver.resolve({ $ref: 'https://example.invalid/s.json' }, ['x']).ruleId, 'ref-remote-refused')
  assert.equal(resolver.resolve({ $ref: './s.json#/Pet' }, ['x']).ruleId, 'ref-external-file-unsupported')
  assert.equal(resolver.resolve({ $ref: '#/components/schemas/Nope' }, ['x']).ruleId, 'ref-unresolved')
  assert.equal(resolver.resolve({ $ref: '#Pet' }, ['x']).ruleId, 'ref-malformed')
})

test('a sibling beside a reference is refused rather than silently ignored', () => {
  assert.equal(resolver.resolve({ $ref: '#/components/schemas/Pet', type: 'string' }, ['x']).ruleId, 'ref-malformed')
  assert.equal(resolver.resolve({ $ref: '#/components/schemas/Pet', description: 'ok', summary: 'ok' }, ['x']).ok, true)
})

test('a chain longer than maxRefDepth is refused by name, not followed anyway', () => {
  const shallow = createResolver(root, { ...DEFAULT_LIMITS, maxRefDepth: 2 })
  assert.equal(shallow.resolve({ $ref: '#/components/schemas/Chain' }, ['x']).ruleId, 'ref-depth-exceeded')
  const enough = createResolver(root, { ...DEFAULT_LIMITS, maxRefDepth: 3 })
  assert.equal(enough.resolve({ $ref: '#/components/schemas/Chain' }, ['x']).ok, true)
})
