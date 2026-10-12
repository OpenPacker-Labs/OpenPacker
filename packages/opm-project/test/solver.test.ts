import { describe, expect, it } from 'vitest';
import {
  CLOSURE_OBJECTIVES,
  loadResolver,
  resolveGraph,
  solveGraph,
} from '../src/index.js';
import { NpmRegistryFixture, plain } from './npm-registry-fixture.js';

/**
 * The PREX solver as a Node program uses it.
 *
 * Two facts about the engine decide whether a real dependency closure can be
 * locked at all, and both were invisible until a live registry was pointed at
 * it: the wasm build is not always there, and the objectives the proof checker
 * can verify stop at 22 universe nodes.
 */

const missing = (code = 'ERR_MODULE_NOT_FOUND') =>
  Object.assign(new Error('Cannot find module'), { code });

describe('loadResolver', () => {
  it('uses the wasm build when it is present', async () => {
    const wasm = async () => ({ marker: 'wasm' });
    const native = async () => {
      throw new Error('the addon must not load when wasm did');
    };
    const resolver = await loadResolver({
      wasm,
      native: native as never,
    });
    expect(resolver).toMatchObject({ bindings: { marker: 'wasm' } });
  });

  it('falls back to the Node-API addon when the wasm build was never made', async () => {
    const addon = { solve: 'addon' };
    const resolver = await loadResolver({
      wasm: async () => {
        throw missing();
      },
      native: async () => addon as never,
    });
    expect(resolver).toBe(addon);
  });

  it('does not hide a wasm build that is present but broken', async () => {
    await expect(
      loadResolver({
        wasm: async () => {
          throw new Error('invalid wasm module');
        },
        native: async () => ({}) as never,
      }),
    ).rejects.toThrow('invalid wasm module');
  });

  it('names both builds when neither exists', async () => {
    await expect(
      loadResolver({
        wasm: async () => {
          throw missing();
        },
        native: async () => {
          throw missing('MODULE_NOT_FOUND');
        },
      }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(/build:wasm.*build:native/su),
    });
  });
});

describe('objectives', () => {
  it('asks the engine for what it can prove at any size', () => {
    expect(CLOSURE_OBJECTIVES).toEqual([
      'satisfy-hard-constraints',
      'exclude-lifecycle-denied',
    ]);
  });
});

/** `chain-0 -> chain-1 -> … -> chain-(length-1)`, one version each. */
function chain(length: number) {
  return Array.from({ length }, (_, index) =>
    plain(`chain-${index}`, {
      '1.0.0':
        index + 1 < length ? { [`chain-${index + 1}`]: '^1.0.0' } : undefined,
    }),
  );
}

async function solveChain(length: number) {
  const transport = new NpmRegistryFixture(chain(length));
  const graph = await resolveGraph({
    roots: [{ purl: 'pkg:npm/chain-0' }],
    options: { transport },
  });
  expect(graph.unresolved).toEqual([]);
  return solveGraph({
    graph,
    rootRequirements: [{ purl: 'pkg:npm/chain-0' }],
  });
}

describe('solveGraph over closures of real size', () => {
  it('solves a handful of nodes', async () => {
    const solved = await solveChain(5);
    expect(solved.selected).toHaveLength(5);
    expect(solved.proofValid).toBe(true);
  });

  it('solves past 22 nodes, where an optimizing request is refused outright', async () => {
    // With the optimizing objectives the engine answers "objective optimality
    // cannot be independently proven above 22 nodes" (and RESOURCE_LIMIT well
    // before that), so no real dependency closure could ever have been locked.
    const solved = await solveChain(23);
    expect(solved.selected).toHaveLength(23);
    expect(solved.proofValid).toBe(true);
    expect(solved.dependencyEdges).toHaveLength(22);
  });

  it('solves a closure of a few hundred nodes', async () => {
    const solved = await solveChain(300);
    expect(solved.selected).toHaveLength(300);
    expect(solved.proofValid).toBe(true);
  });
});

describe('the package bound', () => {
  /** `root` needs ten `leaf-n`, each of which needs `shared` at its own range. */
  const registry = () =>
    new NpmRegistryFixture([
      {
        name: 'root',
        versions: {
          '1.0.0': {
            dependencies: Object.fromEntries(
              Array.from({ length: 10 }, (_, index) => [
                `leaf-${index}`,
                '^1.0.0',
              ]),
            ),
          },
        },
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `leaf-${index}`,
        versions: { '1.0.0': { dependencies: { shared: `>=1.${index}.0` } } },
      })),
      {
        name: 'shared',
        versions: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [`1.${index}.0`, {}]),
        ),
      },
    ]);

  it('counts distinct packages, not the requirement edges that reach them', async () => {
    // 12 packages, but `shared` is asked for at ten different ranges.
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/root' }],
      bounds: { maximumPackages: 12 },
      options: { transport: registry() },
    });
    expect(graph.unresolved).toEqual([]);
    expect(
      new Set(graph.packages.map((item) => item.identity.canonicalPurl)).size,
    ).toBe(12);
  });

  it('still refuses a graph with more packages than the bound', async () => {
    await expect(
      resolveGraph({
        roots: [{ purl: 'pkg:npm/root' }],
        bounds: { maximumPackages: 11 },
        options: { transport: registry() },
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVABLE' });
  });
});
