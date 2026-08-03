import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { formatPurl, parsePurl, parseVers } from '@openpacker/adapter-core';
import { NpmCodec } from '@openpacker/adapter-npm';
import { CargoCodec } from '@openpacker/adapter-cargo';
import { NugetCodec } from '@openpacker/adapter-nuget';
import { canonicalDigest, canonicalize, sha256 } from '@openpacker/canonical';
import { createChunkIndex, reconstruct } from '@openpacker/chunking';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import { reduceLifecycle } from '@openpacker/lifecycle';

const resolver = createEmbeddedResolver(bindings);
const root = new URL('../../', import.meta.url);
const baseInput = {
  request: JSON.parse(
    readFileSync(new URL('fixtures/protocol/solve/request.json', root), 'utf8'),
  ),
  universe: JSON.parse(
    readFileSync(new URL('fixtures/golden/universe.json', root), 'utf8'),
  ),
};
const codecs = [new NpmCodec(), new CargoCodec(), new NugetCodec()];
const version = fc
  .tuple(
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 50 }),
  )
  .map((parts) => parts.join('.'));
const sign = (value) => Math.sign(value);

test('PURL parse, serialize, and ecosystem normalization are idempotent', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...codecs),
      fc.nat(10_000),
      version,
      (codec, index, itemVersion) => {
        const input =
          codec.purlType === 'npm'
            ? `pkg:NPM/%40Scope${index % 13}/Package-${index}@${itemVersion}?B=two&a=one`
            : `pkg:${codec.purlType}/Package-${index}@${itemVersion}?B=two&a=one`;
        const canonical = codec.canonicalizePurl(input);
        const serialized = formatPurl(parsePurl(canonical));
        assert.equal(codec.canonicalizePurl(serialized), canonical);
        assert.equal(resolver.normalizePurl(input), canonical);
      },
    ),
    { seed: 0x5055524c, numRuns: 1_000 },
  );
});

test('VERS parse and canonical serialization are idempotent', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('npm', 'cargo', 'nuget', 'generic'),
      version,
      version,
      (scheme, lower, upper) => {
        const parsed = parseVers(
          `vers:${scheme}/>=${lower} | <${upper} || =${lower}`,
        );
        assert.equal(parseVers(parsed.vers).vers, parsed.vers);
        assert.deepEqual(parseVers(parsed.vers).ast, parsed.ast);
        assert.deepEqual(
          resolver.parseVers(parsed.vers),
          parseVers(parsed.vers),
        );
      },
    ),
    { seed: 0x56455253, numRuns: 1_000 },
  );
});

test('native ranges are either exact VERS equivalents or explicit loss', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...codecs),
      version,
      version,
      version,
      (codec, candidate, lower, upper) => {
        const nativeRange =
          codec.purlType === 'nuget'
            ? `[${lower},${upper})`
            : `>=${lower} <${upper}`;
        const converted = codec.toVers(nativeRange);
        if (converted.vers)
          assert.equal(
            codec.satisfies(candidate, nativeRange),
            resolver.versionSatisfies(candidate, converted.vers),
          );
        else {
          assert.equal(converted.reversible, false);
          assert.ok(converted.semanticLoss.length > 0);
          assert.deepEqual(codec.toVers(nativeRange), converted);
        }
      },
    ),
    { seed: 0x4d454d42, numRuns: 2_000 },
  );
});

test('Rust VERS membership follows SemVer prerelease and build precedence', () => {
  fc.assert(
    fc.property(
      version,
      fc.stringMatching(/^[A-Za-z][0-9A-Za-z-]{0,11}$/u),
      (core, tag) => {
        assert.equal(
          resolver.versionSatisfies(`${core}-${tag}`, `vers:npm/<${core}`),
          true,
        );
        assert.equal(
          resolver.versionSatisfies(
            `${core}+build.1`,
            `vers:cargo/=${core}+build.2`,
          ),
          true,
        );
      },
    ),
    { seed: 0x53454d56, numRuns: 500 },
  );
});

test('ecosystem comparators define a total order', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...codecs),
      version,
      version,
      version,
      (codec, left, middle, right) => {
        const compare = (a, b) => sign(codec.compareNativeVersions(a, b));
        assert.equal(compare(left, left), 0);
        assert.equal(compare(left, middle), -compare(middle, left));
        assert.ok(compare(left, middle) <= 0 || compare(middle, left) <= 0);
        if (compare(left, middle) <= 0 && compare(middle, right) <= 0)
          assert.ok(compare(left, right) <= 0);
      },
    ),
    { seed: 0x4f524445, numRuns: 2_000 },
  );
});

test('TypeScript and Rust produce identical canonical bytes', () => {
  const scalar = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc.string(),
  );
  const json = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      scalar,
      tie('array'),
      tie('object'),
    ),
    array: fc.array(tie('value'), { maxLength: 8 }),
    object: fc.dictionary(fc.string(), tie('value'), { maxKeys: 8 }),
  })).value;
  fc.assert(
    fc.property(json, (value) => {
      assert.equal(resolver.canonicalize(value), canonicalize(value));
    }),
    { seed: 0x54535253, numRuns: 1_000 },
  );
});

test('TypeScript and Rust canonicalize receipt and lockfile goldens identically', async () => {
  for (const name of ['receipt', 'lockfile']) {
    const value = JSON.parse(
      readFileSync(new URL(`fixtures/golden/${name}.json`, root), 'utf8'),
    );
    assert.equal(resolver.canonicalize(value), canonicalize(value));
    assert.deepEqual(resolver.digest(value), await canonicalDigest(value));
  }
});

test('chunk split and reconstruct is identity for generated bytes', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 1, maxLength: 4_096 }),
      async (bytes) => {
        const digest = await sha256(bytes);
        const chunks = new Map();
        const index = await createChunkIndex(
          new Blob([bytes]).stream(),
          { digest, size: bytes.byteLength },
          { minimumSize: 32, averageSize: 64, maximumSize: 128 },
          (chunk, record) => chunks.set(record.offset, chunk),
        );
        const rebuilt = await reconstruct(index, async (record) => {
          const chunk = chunks.get(record.offset);
          assert.ok(chunk);
          return chunk;
        });
        assert.deepEqual(rebuilt, bytes);
      },
    ),
    { seed: 0x4348554e, numRuns: 100 },
  );
});

const digest = { algorithm: 'sha256', value: 'a'.repeat(64) };
const identity = {
  canonicalPurl: 'pkg:npm/demo',
  exactPurl: 'pkg:npm/demo@1.0.0',
  purlType: 'npm',
  name: 'demo',
  version: '1.0.0',
  qualifiers: {},
  nativeCoordinates: [],
  aliases: [],
  sourceRefs: [],
  publisherRefs: [],
  externalRefs: [],
};
const lifecycleEvent = (eventId, action, effectiveAt) => ({
  eventVersion: '1',
  eventId,
  subject: identity,
  action,
  effectiveAt,
  issuedAt: effectiveAt,
  actor: { type: 'key', value: 'fixture' },
  authority: 'registry',
  reasonCode: `fixture.${action}`,
  replacementRefs: [],
  sourceSnapshot: digest,
  evidenceRefs: [],
  externalRefs: [],
});
const lifecycleEvents = [
  lifecycleEvent('publish', 'published', '2026-01-01T00:00:00Z'),
  lifecycleEvent('yank', 'yanked', '2026-02-01T00:00:00Z'),
  lifecycleEvent('restore', 'restored', '2026-03-01T00:00:00Z'),
];
const lifecycleRules = [
  {
    authority: 'registry',
    scopes: ['exact-version'],
    actions: ['published', 'yanked', 'restored'],
  },
];

test('lifecycle reduction is independent of input order', async () => {
  const expected = await reduceLifecycle(
    lifecycleEvents,
    { packagePurl: identity.canonicalPurl, exactPurl: identity.exactPurl },
    '2026-04-01T00:00:00Z',
    lifecycleRules,
  );
  await fc.assert(
    fc.asyncProperty(
      fc.shuffledSubarray(lifecycleEvents, {
        minLength: lifecycleEvents.length,
        maxLength: lifecycleEvents.length,
      }),
      async (events) => {
        assert.deepEqual(
          await reduceLifecycle(
            events,
            {
              packagePurl: identity.canonicalPurl,
              exactPurl: identity.exactPurl,
            },
            '2026-04-01T00:00:00Z',
            lifecycleRules,
          ),
          expected,
        );
      },
    ),
    { seed: 0x4c494645, numRuns: 100 },
  );
});

test('target predicate resolution is deterministic for generated targets', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        { os: 'linux', architecture: 'arm64', provider: '825cac7e' },
        { os: 'windows', architecture: 'x64', provider: '85c19ecd' },
      ),
      (target) => {
        const input = structuredClone(baseInput);
        Object.assign(input.request.target, target);
        delete input.request.target.provider;
        const first = resolver.solve(input);
        const second = resolver.solve(input);
        assert.deepEqual(second, first);
        assert.ok(
          first.solution.selectedCapabilityProviders[0].providerNodeId.includes(
            target.provider,
          ),
        );
      },
    ),
    { seed: 0x54415247, numRuns: 50 },
  );
});

test('every generated solver solution satisfies hard constraints', () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(baseInput.universe.packages, {
        minLength: baseInput.universe.packages.length,
        maxLength: baseInput.universe.packages.length,
      }),
      (packages) => {
        const input = structuredClone(baseInput);
        input.universe.packages = packages;
        const output = resolver.solve(input);
        assert.deepEqual(resolver.check(input, output), {
          valid: true,
          diagnostics: [],
        });
      },
    ),
    { seed: 0x48415244, numRuns: 50 },
  );
});

test('objective ordering is deterministic', () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(baseInput.request.objectives, {
        minLength: baseInput.request.objectives.length,
        maxLength: baseInput.request.objectives.length,
      }),
      (objectives) => {
        const input = structuredClone(baseInput);
        input.request.objectives = objectives;
        const first = resolver.solve(input);
        assert.deepEqual(resolver.solve(input), first);
        assert.deepEqual(resolver.check(input, first), {
          valid: true,
          diagnostics: [],
        });
        assert.deepEqual(
          resolver.bruteForceOracle(input).selectedNodeIds,
          first.solution.selectedNodeIds,
        );
      },
    ),
    { seed: 0x4f424a45, numRuns: 50 },
  );
});

test('invalid proof mutations are rejected', () => {
  const output = resolver.solve(baseInput);
  fc.assert(
    fc.property(
      fc.constantFrom(
        'assignment',
        'universe-digest',
        'witness',
        'all-witnesses',
        'conflict-checks',
        'cardinality-checks',
        'target-checks',
        'objective-evidence',
        'selected-object',
      ),
      (mutation) => {
        const malformed = structuredClone(output);
        if (mutation === 'assignment')
          malformed.proof.selectedAssignments[0].selected =
            !malformed.proof.selectedAssignments[0].selected;
        else if (mutation === 'universe-digest')
          malformed.proof.universeDigest.value = '0'.repeat(64);
        else if (mutation === 'witness')
          malformed.proof.requirementWitnesses[0].witnessNodeIds = [];
        else if (mutation === 'all-witnesses')
          malformed.proof.requirementWitnesses = [];
        else if (mutation === 'conflict-checks')
          malformed.proof.conflictChecks = [];
        else if (mutation === 'cardinality-checks')
          malformed.proof.cardinalityChecks = [];
        else if (mutation === 'target-checks')
          malformed.proof.targetChecks = [];
        else if (mutation === 'objective-evidence')
          malformed.proof.objectiveEvidence = [];
        else malformed.selected[0].nativeVersion = '999.0.0';
        assert.equal(resolver.check(baseInput, malformed).valid, false);
      },
    ),
    { seed: 0x50524f4f, numRuns: 100 },
  );
});
