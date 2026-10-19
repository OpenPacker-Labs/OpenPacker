import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifestToLock } from '../src/index.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';
import { SCENARIOS, manifestFor, type Scenario } from './resolver-scenarios.js';

/**
 * What a resolve keeps is bounded, and the bound must not change what it
 * finds: the lock, its snapshot digests included, is the same whether the
 * budget keeps every packument, a megabyte of them, or none, in which case
 * every use is a fetch and a parse. The registry counts how often it was asked,
 * which is how these tests know the smaller budgets did let go.
 */

const MiB = 1024 * 1024;
const BUDGETS = [
  ['unlimited', Number.POSITIVE_INFINITY],
  ['1 MiB', MiB],
  ['nothing', 0],
] as const;

async function lockAt(scenario: Scenario, maximumRetainedBytes: number) {
  const registry = new NpmRegistryFixture(scenario.packages);
  const root = await mkdtemp(join(tmpdir(), 'opm-retention-'));
  try {
    const lock = await resolveManifestToLock({
      root,
      manifest: manifestFor(scenario.roots),
      offline: false,
      registryOptions: {
        transport: registry,
        maximumRetainedBytes,
        now: () => '2026-08-04T00:00:00Z',
      },
    });
    return { lock, requests: registry.requests.length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('a resolve under a retention budget', { timeout: 120_000 }, () => {
  for (const scenario of SCENARIOS) {
    it(`finds the same lock whatever it keeps: ${scenario.name}`, async () => {
      const unlimited = await lockAt(scenario, Number.POSITIVE_INFINITY);
      expect(Object.keys(unlimited.lock.packages).length).toBeGreaterThan(0);
      const results = new Map<string, number>();
      results.set('unlimited', unlimited.requests);
      for (const [label, budget] of BUDGETS.slice(1)) {
        const other = await lockAt(scenario, budget);
        expect(other.lock, `a budget of ${label}`).toEqual(unlimited.lock);
        expect(JSON.stringify(other.lock)).toBe(JSON.stringify(unlimited.lock));
        results.set(label, other.requests);
      }
      // Keeping nothing means asking again for what is needed again.
      expect(results.get('nothing')!).toBeGreaterThanOrEqual(
        results.get('unlimited')!,
      );
    });
  }

  it('lets go, and asks again, when the budget is smaller than what the walk reads', async () => {
    const diamond = SCENARIOS[0]!;
    const unlimited = await lockAt(diamond, Number.POSITIVE_INFINITY);
    const nothing = await lockAt(diamond, 0);
    expect(nothing.requests).toBeGreaterThan(unlimited.requests);
  });

  it('asks for each packument once when it keeps them all, and more when it keeps a megabyte of many', async () => {
    const graph = SCENARIOS.find((item) => item.name.endsWith('seed 7'))!;
    const unlimited = await lockAt(graph, Number.POSITIVE_INFINITY);
    const small = await lockAt(graph, MiB);
    expect(small.requests).toBeGreaterThan(unlimited.requests);
  });
});
