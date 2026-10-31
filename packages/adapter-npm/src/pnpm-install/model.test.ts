import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXTURES,
  fixtureBytes,
  fixtureText,
  withBlocksReversed,
  type FixtureName,
} from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { buildPnpmModel, type PnpmModel } from './model.js';

interface Oracle {
  sha256: string;
  instances: number;
  tops: number;
  instanceEdges: number;
  optionalEdges: number;
  snapshotAliasEdges: number;
  snapshotLinks: number;
  topEdges: number;
  topLinks: number;
  optionalInstances: number;
  edgesSha256: string;
}

/**
 * `model-oracle.py` read each fixture with PyYAML and none of this model's
 * logic: how many instances and edges a frozen install builds, and a hash over
 * the canonical list of them.
 */
const ORACLE: Record<string, Oracle> = JSON.parse(
  readFileSync(
    new URL(
      '../../../../fixtures/locks/pnpm-v9/model-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const ORACLE_FIXTURES = FIXTURES.filter((name) => name in ORACLE);

function modelOf(input: string | Uint8Array): PnpmModel {
  return buildPnpmModel(readPnpmLock(input).lock);
}

/** The oracle's canonical listing, written from the model. */
function canonicalEdges(model: PnpmModel): string {
  const lines: string[] = [];
  for (const instance of [...model.instances.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  ))
    for (const edge of [...instance.edges].sort(
      (a, b) =>
        Number(a.optional) - Number(b.optional) ||
        (a.as < b.as ? -1 : a.as > b.as ? 1 : 0),
    ))
      lines.push(
        `S\t${instance.key}\t${edge.as}\tdep\t${edge.to}\t${Number(edge.optional)}`,
      );
  for (const top of [...model.tops.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  ))
    for (const list of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ] as const)
      for (const edge of top.edges
        .filter((candidate) => candidate.list === list)
        .sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0)))
        lines.push(
          edge.kind === 'dep'
            ? `I\t${top.id}\t${list}\t${edge.as}\t${edge.specifier}\tdep\t${edge.to}`
            : `I\t${top.id}\t${list}\t${edge.as}\t${edge.specifier}\tlink\t${edge.target}`,
        );
  return lines.join('\n');
}

describe.each(ORACLE_FIXTURES)('the model of %s', (name: FixtureName) => {
  const expected = ORACLE[name]!;
  const model = modelOf(fixtureBytes(name));

  it('is built from the file the oracle read', () => {
    expect(createHash('sha256').update(fixtureBytes(name)).digest('hex')).toBe(
      expected.sha256,
    );
  });

  it('has an instance for every snapshot and a top for every importer', () => {
    expect(model.instances.size).toBe(expected.instances);
    expect(model.tops.size).toBe(expected.tops);
    expect(
      [...model.instances.values()].filter((instance) => instance.optional),
    ).toHaveLength(expected.optionalInstances);
  });

  it('has the edges an independent reading found', () => {
    const edges = [...model.instances.values()].flatMap((i) => i.edges);
    expect(edges).toHaveLength(expected.instanceEdges);
    expect(edges.filter((edge) => edge.optional)).toHaveLength(
      expected.optionalEdges,
    );
    const tops = [...model.tops.values()].flatMap((top) => top.edges);
    expect(tops).toHaveLength(expected.topEdges);
    expect(tops.filter((edge) => edge.kind === 'link')).toHaveLength(
      expected.topLinks,
    );
    expect(
      edges.filter((edge) => model.instances.get(edge.to)!.name !== edge.as),
    ).toHaveLength(expected.snapshotAliasEdges);
  });

  it('lists exactly the edges the oracle listed', () => {
    const listing = canonicalEdges(model);
    expect(createHash('sha256').update(listing).digest('hex')).toBe(
      expected.edgesSha256,
    );
  });

  it('is the same model whatever order the lock lists its blocks in', () => {
    const reversed = modelOf(withBlocksReversed(fixtureText(name)));
    expect(canonicalEdges(reversed)).toBe(canonicalEdges(model));
    expect([...reversed.instances.keys()]).toEqual([...model.instances.keys()]);
    expect([...reversed.tops.keys()]).toEqual([...model.tops.keys()]);
  });

  it('points every edge at an instance of the model and every instance at its package', () => {
    for (const instance of model.instances.values()) {
      expect(instance.pkg.key).toBe(instance.packageKey);
      expect(instance.packageKey).toBe(`${instance.name}@${instance.version}`);
      for (const edge of instance.edges)
        expect(model.instances.has(edge.to)).toBe(true);
    }
    for (const top of model.tops.values())
      for (const edge of top.edges)
        if (edge.kind === 'dep')
          expect(model.instances.has(edge.to)).toBe(true);
        else expect(model.tops.has(edge.memberId ?? '')).toBe(true);
  });
});

describe('what the model keeps of a lock', () => {
  const hobo = modelOf(fixtureBytes('hobo.cut.pnpm-lock.yaml'));
  const aiBdd = modelOf(fixtureBytes('ai-bdd.pnpm-lock.yaml'));

  it('keeps the variants of one package as separate instances of one package', () => {
    const variants = [...hobo.instances.values()].filter(
      (instance) => instance.packageKey === 'openai@6.26.0',
    );
    expect(variants.map((instance) => instance.key).sort()).toEqual([
      'openai@6.26.0(ws@8.21.0)(zod@3.25.76)',
      'openai@6.26.0(ws@8.21.0)(zod@4.4.3)',
    ]);
    // The package is shared: one integrity, one set of claims.
    expect(variants[0]!.pkg).toBe(variants[1]!.pkg);
    // Each variant's peers are its own edges.
    const zod = (key: string) =>
      hobo.instances.get(key)!.edges.find((edge) => edge.as === 'zod')!.to;
    expect(zod('openai@6.26.0(ws@8.21.0)(zod@3.25.76)')).toBe('zod@3.25.76');
    expect(zod('openai@6.26.0(ws@8.21.0)(zod@4.4.3)')).toBe('zod@4.4.3');
  });

  it('installs an alias under its own name and as the target package', () => {
    const codex = hobo.instances.get('@openai/codex@0.136.0')!;
    const edge = codex.edges.find(
      (candidate) => candidate.as === '@openai/codex-linux-x64',
    )!;
    expect(edge).toMatchObject({
      to: '@openai/codex@0.136.0-linux-x64',
      optional: true,
    });
    const target = hobo.instances.get(edge.to)!;
    expect(target).toMatchObject({
      name: '@openai/codex',
      version: '0.136.0-linux-x64',
      optional: true,
    });
    expect(target.pkg.os).toEqual(['linux']);
    expect(target.pkg.cpu).toEqual(['x64']);
  });

  it('turns a workspace link into an edge to the importer it lands on', () => {
    const root = aiBdd.tops.get('.')!;
    const cli = root.edges.find((edge) => edge.as === '@ai-bdd/cli')!;
    expect(cli).toMatchObject({
      kind: 'link',
      list: 'devDependencies',
      specifier: 'workspace:*',
      memberId: 'packages/cli',
    });
    const training = hobo.tops
      .get('external/ts-autocode/packages/training')!
      .edges.find((edge) => edge.as === 'ts-autocode-rewrite')!;
    expect(training).toMatchObject({
      kind: 'link',
      memberId: 'external/ts-autocode/packages/rewrite',
    });
  });

  it('gives the project directory as the empty string and a member its own', () => {
    expect(aiBdd.tops.get('.')!.dir).toBe('');
    expect(aiBdd.tops.get('packages/sdk')!.dir).toBe('packages/sdk');
  });

  it('keeps which list a direct dependency was in, and the specifier', () => {
    const edges = aiBdd.tops.get('.')!.edges;
    const vitest = edges.find((edge) => edge.as === 'vitest')!;
    expect(vitest).toMatchObject({
      kind: 'dep',
      list: 'devDependencies',
      specifier: '^5.0.3',
    });
    expect(vitest.kind === 'dep' && vitest.to).toMatch(/^vitest@5\.0\.3\(/u);
  });
});
