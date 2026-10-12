import { describe, expect, it } from 'vitest';
import { formatDepPath, type DepPath } from './dep-path.js';
import {
  FIXTURES,
  expectedCounts,
  fixtureBytes,
  fixtureSha256,
  fixtureText,
  withBlocksReversed,
} from './fixture-support.js';
import { readPnpmLock, parsePnpmLock } from './index.js';
import { summarizePnpmLock } from './summary.js';
import { validatePnpmLock } from './validate.js';

describe.each(FIXTURES)('%s', (name) => {
  const expected = expectedCounts(name);

  it('is the file the counts were taken from', () => {
    expect(fixtureSha256(name)).toBe(expected.sha256);
  });

  it('reads, and agrees with itself', () => {
    const { report } = readPnpmLock(fixtureBytes(name));
    expect(report.problemCount).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it('has the importers, packages, snapshots and edges an independent count found', () => {
    const summary = summarizePnpmLock(parsePnpmLock(fixtureBytes(name)));
    expect(summary).toMatchObject({
      lockfileVersion: '9.0',
      importers: expected.importers,
      packages: expected.packages,
      snapshots: expected.snapshots,
      dependencyEdges: expected.dependencyEdges,
      linkEdges: expected.linkEdges,
      aliasEdges: expected.aliasEdges,
      exoticSources: expected.exoticSources,
    });
    expect(summary.multiVersionNames).toEqual(expected.multiVersionNames);
    expect(summary.platformRestricted).toEqual(expected.platformRestricted);
  });

  it('has the orphans, patched snapshots and peer nesting an independent count found', () => {
    const lock = parsePnpmLock(fixtureBytes(name));
    const report = validatePnpmLock(lock);
    expect(report.orphanPackages).toEqual(expected.orphanPackages);
    expect(report.orphanSnapshots).toEqual(expected.orphanSnapshots);
    const withSuffix = lock.snapshots.filter(
      (s) =>
        s.path.patchHash !== undefined ||
        s.path.peersHash !== undefined ||
        s.path.peers.length > 0,
    );
    expect(withSuffix).toHaveLength(expected.peerSuffixedSnapshots);
    expect(
      lock.snapshots.filter((s) => s.path.patchHash !== undefined),
    ).toHaveLength(expected.patchedSnapshots);
    expect(Math.max(0, ...lock.snapshots.map((s) => groupDepth(s.path)))).toBe(
      expected.deepestPeerNesting,
    );
  });

  it('places every link on a workspace member', () => {
    const { report } = readPnpmLock(fixtureBytes(name));
    for (const link of report.links.filter((l) => l.owner === 'importer'))
      expect(link.member).toBe(true);
    expect(report.links).toHaveLength(
      expected.linkEdges.importers + expected.linkEdges.snapshots,
    );
  });

  it('formats every key and every dependency value back to the text it came from', () => {
    const lock = parsePnpmLock(fixtureBytes(name));
    for (const snapshot of lock.snapshots) {
      expect(formatDepPath(snapshot.path)).toBe(snapshot.key);
      for (const edge of [
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      ])
        if (edge.ref.kind === 'dep')
          expect(formatDepPath(edge.ref.target)).toBe(edge.ref.target.raw);
    }
  });

  it('keeps every collection in code unit order', () => {
    const lock = parsePnpmLock(fixtureBytes(name));
    const sorted = (keys: readonly string[]) =>
      [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const keys of [
      lock.importers.map((i) => i.id),
      lock.packages.map((p) => p.key),
      lock.snapshots.map((s) => s.key),
      ...lock.snapshots.map((s) => s.dependencies.map((d) => d.name)),
    ])
      expect(keys).toEqual(sorted(keys));
  });

  it('reads to the same model whatever order the file lists its entries in', () => {
    const text = fixtureText(name);
    const reversed = withBlocksReversed(text);
    expect(reversed).not.toBe(text);
    expect(parsePnpmLock(reversed)).toEqual(parsePnpmLock(text));
  });
});

describe('long-key.pnpm-lock.yaml', () => {
  const text = fixtureText('long-key.pnpm-lock.yaml');

  it('has a snapshot key of more than 1024 characters, written as pnpm writes one (`? key`, then `: value`), and reads it whole', () => {
    const lock = parsePnpmLock(text);
    const [longest] = [...lock.snapshots].sort(
      (a, b) => b.key.length - a.key.length,
    );
    expect(longest?.key.length).toBe(1358);
    expect(longest?.path.peers).toHaveLength(45);
    expect(text).toContain(`\n  ? ${longest?.key}\n  : dependencies:\n`);
  });

  it('is refused with a message that says what to do when the key is written on one line', () => {
    const implicit = text
      .split('\n')
      .flatMap((line) =>
        line.startsWith('  ? ')
          ? [`  ${line.slice(4)}:`]
          : line === '  : dependencies:'
            ? ['    dependencies:']
            : [line],
      )
      .join('\n');
    expect(implicit).not.toBe(text);
    let raised: unknown;
    try {
      parsePnpmLock(implicit);
    } catch (error) {
      raised = error;
    }
    expect(raised).toMatchObject({
      reason: 'yaml-syntax',
      message: expect.stringContaining('explicit form'),
    });
  });
});

/** How deep the parentheses of a key nest: a group is one level, and a peer's own groups are inside it. */
function groupDepth(path: DepPath): number {
  const own =
    path.patchHash !== undefined || path.peersHash !== undefined ? 1 : 0;
  const peers =
    path.peers.length === 0 ? 0 : 1 + Math.max(...path.peers.map(groupDepth));
  return Math.max(own, peers);
}
