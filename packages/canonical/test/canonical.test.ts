import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canonicalProjectionDigest,
  canonicalDigest,
  canonicalize,
  formatDigest,
  parseCanonicalJson,
  parseDigest,
  projectCanonicalValue,
  sha256,
} from '../src/index.js';
import { DIGEST_PROJECTIONS, type JsonValue } from '@openpacker/contracts';

const projectionFor = (id: string) => {
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === id,
  );
  if (!projection) throw new Error(`unknown projection ${id}`);
  return projection;
};

const protocolFixture = async (
  group: string,
  name: string,
): Promise<JsonValue> =>
  JSON.parse(
    await readFile(
      new URL(
        `../../../fixtures/protocol/${group}/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as JsonValue;

const realisationFixture = (name: string) =>
  protocolFixture('realisation', name);
const environmentFixture = (name: string) =>
  protocolFixture('environment', name);
const nixFixture = (name: string) => protocolFixture('nix', name);

describe('PREX canonical JSON', () => {
  it('sorts keys recursively without changing array order', () => {
    expect(canonicalize({ z: 1, a: { y: true, x: [3, 2, 1] } })).toBe(
      '{"a":{"x":[3,2,1],"y":true},"z":1}',
    );
  });

  it('rejects duplicate members before object construction', () => {
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(
      /Duplicate object member/,
    );
  });

  it.each(['-0', '1.5', '9007199254740992', '"\\ud800"'])(
    'rejects non-PREX I-JSON %s',
    (input) => {
      expect(() => parseCanonicalJson(input)).toThrow();
    },
  );

  it('rejects cycles and non-JSON values', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalize(value as never)).toThrow(/Cyclic/);
    expect(() => canonicalize({ value: undefined } as never)).toThrow(
      /Unsupported/,
    );
  });

  it('hashes canonical UTF-8 bytes and round-trips digest strings', async () => {
    const digest = await canonicalDigest({});
    expect(formatDigest(digest)).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(parseDigest(formatDigest(digest))).toEqual(digest);
    expect(await sha256(new Uint8Array())).toEqual({
      algorithm: 'sha256',
      value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('applies named digest projections without mutating the input', async () => {
    const projection = DIGEST_PROJECTIONS.projections.find(
      ({ id }) => id === 'universe-v1',
    )!;
    const value = {
      universeVersion: '1',
      packages: [{ nodeId: 'b' }, { nodeId: 'a' }],
      overlays: [],
      sourceSnapshots: [],
      canonicalDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    };
    expect(projectCanonicalValue(value, projection)).toEqual({
      universeVersion: '1',
      packages: [{ nodeId: 'a' }, { nodeId: 'b' }],
      overlays: [],
      sourceSnapshots: [],
    });
    expect(value.packages[0]?.nodeId).toBe('b');
    expect(
      formatDigest(await canonicalProjectionDigest(value, projection)),
    ).toBe(
      'sha256:4b1d2f63f36b7bb39a1330fcc07c7735100de097e10c32cbd6a4805c4f917935',
    );
  });

  it('sorts captured recipes into the universe projection', () => {
    const projection = projectionFor('universe-v1');
    const value = {
      universeVersion: '1',
      packages: [],
      overlays: [],
      recipes: [{ recipeVersion: '1', kind: 'source-build' }, { kind: 'aaa' }],
      sourceSnapshots: [],
      canonicalDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    };
    expect(
      (projectCanonicalValue(value, projection) as { recipes: unknown[] })
        .recipes,
    ).toEqual([{ kind: 'aaa' }, { recipeVersion: '1', kind: 'source-build' }]);
  });
});

describe('realisation digest projections', () => {
  it('pins tree, recipe, recipe-output, and substitute digests', async () => {
    const pinned = (await realisationFixture('projection-digests')) as {
      treeManifest: { value: string };
      treeManifestDev: { value: string };
      buildRecipe: { value: string };
      recipeOutputIds: Record<string, { value: string }>;
      substitute: { value: string };
    };

    const treeDigest = await canonicalProjectionDigest(
      await realisationFixture('tree-manifest'),
      projectionFor('tree-manifest-v1'),
    );
    expect(treeDigest.value).toBe(pinned.treeManifest.value);
    const devTreeDigest = await canonicalProjectionDigest(
      await realisationFixture('tree-manifest-dev'),
      projectionFor('tree-manifest-v1'),
    );
    expect(devTreeDigest.value).toBe(pinned.treeManifestDev.value);
    expect(devTreeDigest.value).not.toBe(treeDigest.value);

    const recipeDigest = await canonicalProjectionDigest(
      await realisationFixture('build-recipe'),
      projectionFor('build-recipe-v1'),
    );
    expect(recipeDigest.value).toBe(pinned.buildRecipe.value);

    // recipeOutputId derives identity from the plan before any bytes exist.
    for (const outputName of ['out', 'dev']) {
      const outputId = await canonicalProjectionDigest(
        { outputName, recipeDigest } as unknown as JsonValue,
        projectionFor('recipe-output-v1'),
      );
      expect(outputId.value).toBe(pinned.recipeOutputIds[outputName]?.value);
    }
    expect(pinned.recipeOutputIds.out?.value).not.toBe(
      pinned.recipeOutputIds.dev?.value,
    );

    const substituteDigest = await canonicalProjectionDigest(
      await realisationFixture('substitute'),
      projectionFor('substitute-v1'),
    );
    expect(substituteDigest.value).toBe(pinned.substitute.value);
  });

  it('excludes mutable locations from the substitute projection', async () => {
    const projection = projectionFor('substitute-v1');
    const direct = await canonicalProjectionDigest(
      await realisationFixture('substitute'),
      projection,
    );
    const mirrored = await canonicalProjectionDigest(
      await realisationFixture('substitute-mirrored'),
      projection,
    );
    expect(mirrored.value).toBe(direct.value);
  });

  it('changes the tree digest when any file digest changes', async () => {
    const projection = projectionFor('tree-manifest-v1');
    const manifest = (await realisationFixture('tree-manifest')) as {
      entries: { kind: string; digest?: { value: string } }[];
    };
    const before = await canonicalProjectionDigest(
      manifest as unknown as JsonValue,
      projection,
    );
    const tampered = structuredClone(manifest);
    const file = tampered.entries.find((entry) => entry.kind === 'executable');
    if (!file?.digest) throw new Error('fixture must contain an executable');
    file.digest.value = 'f'.repeat(64);
    const after = await canonicalProjectionDigest(
      tampered as unknown as JsonValue,
      projection,
    );
    expect(after.value).not.toBe(before.value);
  });

  it('binds an artifact to the recipe output that produced it', async () => {
    const descriptor = (await realisationFixture('artifact-descriptor')) as {
      treeDigest: { value: string };
      producedBy: { recipeDigest: { value: string }; outputName: string };
    };
    const recipeDigest = await canonicalProjectionDigest(
      await realisationFixture('build-recipe'),
      projectionFor('build-recipe-v1'),
    );
    expect(descriptor.producedBy.recipeDigest.value).toBe(recipeDigest.value);
    const treeDigest = await canonicalProjectionDigest(
      await realisationFixture('tree-manifest'),
      projectionFor('tree-manifest-v1'),
    );
    expect(descriptor.treeDigest.value).toBe(treeDigest.value);
  });
});

describe('environment generation ledger', () => {
  it('pins manifest and generation digests', async () => {
    const pinned = (await environmentFixture('projection-digests')) as {
      manifest: { value: string };
      generation1: { value: string };
      generation2: { value: string };
    };
    const manifestDigest = await canonicalProjectionDigest(
      await environmentFixture('manifest'),
      projectionFor('environment-manifest-v1'),
    );
    expect(manifestDigest.value).toBe(pinned.manifest.value);

    for (const [name, expected] of [
      ['generation-1', pinned.generation1],
      ['generation-2', pinned.generation2],
    ] as const) {
      const generation = (await environmentFixture(name)) as {
        generationDigest: { value: string };
      };
      expect(generation.generationDigest.value).toBe(expected.value);
    }
  });

  it('recomputes a generation digest without its own field', async () => {
    const projection = projectionFor('environment-generation-v1');
    const generation = (await environmentFixture('generation-2')) as Record<
      string,
      unknown
    >;
    // The stored digest must equal the projection of the record, and the
    // projection must not depend on the stored value.
    const recomputed = await canonicalProjectionDigest(
      generation as JsonValue,
      projection,
    );
    expect(recomputed.value).toBe(
      (generation.generationDigest as { value: string }).value,
    );
    const tampered = {
      ...generation,
      generationDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
    };
    const fromTampered = await canonicalProjectionDigest(
      tampered as JsonValue,
      projection,
    );
    expect(fromTampered.value).toBe(recomputed.value);
  });

  it('links generations into a tamper-evident chain', async () => {
    const first = (await environmentFixture('generation-1')) as {
      generationDigest: { value: string };
    };
    const second = (await environmentFixture('generation-2')) as {
      parentGenerationDigest: { value: string };
      sequence: number;
    };
    expect(second.parentGenerationDigest.value).toBe(
      first.generationDigest.value,
    );
    expect(second.sequence).toBe(2);

    // Editing any earlier generation breaks the link to its child.
    const projection = projectionFor('environment-generation-v1');
    const edited = structuredClone(
      (await environmentFixture('generation-1')) as Record<string, unknown>,
    );
    (edited as { sequence: number }).sequence = 99;
    const editedDigest = await canonicalProjectionDigest(
      edited as JsonValue,
      projection,
    );
    expect(editedDigest.value).not.toBe(second.parentGenerationDigest.value);
  });

  it('rolls back by repointing state, never by rewriting generations', async () => {
    const state = (await environmentFixture('state')) as {
      currentGenerationDigest: { value: string };
      retainedGenerationDigests: { value: string }[];
    };
    const rolledBack = (await environmentFixture('state-rolled-back')) as {
      currentGenerationDigest: { value: string };
      retainedGenerationDigests: { value: string }[];
    };
    const first = (await environmentFixture('generation-1')) as {
      generationDigest: { value: string };
    };
    const second = (await environmentFixture('generation-2')) as {
      generationDigest: { value: string };
    };

    expect(state.currentGenerationDigest.value).toBe(
      second.generationDigest.value,
    );
    expect(rolledBack.currentGenerationDigest.value).toBe(
      first.generationDigest.value,
    );
    // Rollback retains both records, so it stays reversible and collectible
    // content stays reachable.
    expect(
      rolledBack.retainedGenerationDigests.map((item) => item.value),
    ).toEqual(state.retainedGenerationDigests.map((item) => item.value));
    for (const pointer of [state, rolledBack])
      expect(
        pointer.retainedGenerationDigests.map((item) => item.value),
      ).toContain(pointer.currentGenerationDigest.value);
  });
});

describe('nix worked example', () => {
  it('derives output identity from the captured derivation', async () => {
    const pinned = (await nixFixture('projection-digests')) as {
      treeOut: { value: string };
      treeDev: { value: string };
      buildRecipe: { value: string };
      recipeOutputIds: Record<string, { value: string }>;
      universe: { value: string };
    };
    const recipeDigest = await canonicalProjectionDigest(
      await nixFixture('build-recipe'),
      projectionFor('build-recipe-v1'),
    );
    expect(recipeDigest.value).toBe(pinned.buildRecipe.value);

    // Both outputs share one plan and differ only by output name, which is
    // exactly how a multi-output derivation behaves.
    const ids = await Promise.all(
      ['out', 'dev'].map(async (outputName) => {
        const id = await canonicalProjectionDigest(
          { outputName, recipeDigest } as unknown as JsonValue,
          projectionFor('recipe-output-v1'),
        );
        expect(id.value).toBe(pinned.recipeOutputIds[outputName]?.value);
        return id.value;
      }),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('gives each store output a distinct node identity and tree digest', async () => {
    const universe = (await nixFixture('universe')) as {
      packages: {
        nodeId: string;
        identity: { exactPurl: string; qualifiers: Record<string, string> };
        artifacts: { treeDigest: { value: string } }[];
      }[];
      canonicalDigest: { value: string };
      recipes: unknown[];
    };
    const [out, dev] = universe.packages;
    if (!out || !dev) throw new Error('fixture must contain both outputs');

    // Same package and version; different output, so different node identity.
    expect(out.identity.qualifiers.plan).toBe(dev.identity.qualifiers.plan);
    expect(out.identity.qualifiers.output).toBe('out');
    expect(dev.identity.qualifiers.output).toBe('dev');
    expect(out.identity.qualifiers.outhash).not.toBe(
      dev.identity.qualifiers.outhash,
    );
    expect(out.nodeId).not.toBe(dev.nodeId);
    expect(out.artifacts[0]?.treeDigest.value).not.toBe(
      dev.artifacts[0]?.treeDigest.value,
    );

    const pinned = (await nixFixture('projection-digests')) as {
      treeOut: { value: string };
      universe: { value: string };
    };
    const treeDigest = await canonicalProjectionDigest(
      await nixFixture('tree-manifest-out'),
      projectionFor('tree-manifest-v1'),
    );
    expect(treeDigest.value).toBe(pinned.treeOut.value);
    expect(out.artifacts[0]?.treeDigest.value).toBe(pinned.treeOut.value);

    const universeDigest = await canonicalProjectionDigest(
      universe as unknown as JsonValue,
      projectionFor('universe-v1'),
    );
    expect(universeDigest.value).toBe(pinned.universe.value);
  });

  it('keeps store-path hashes opaque and records the loss', async () => {
    const universe = (await nixFixture('universe')) as {
      packages: {
        semanticLoss: { code: string; severity: string }[];
        identity: { qualifiers: Record<string, string> };
      }[];
    };
    for (const item of universe.packages) {
      // A Nix store hash is truncated base32, so it is not a PREX digest and
      // must not pretend to be one.
      expect(item.identity.qualifiers.outhash).not.toMatch(/^[0-9a-f]{64}$/);
      expect(
        item.semanticLoss.some(
          (loss) => loss.code === 'NIX_STORE_PATH_HASH_OPAQUE',
        ),
      ).toBe(true);
    }
  });
});
