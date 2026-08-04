import { describe, expect, it } from 'vitest';
import {
  assembleClosure,
  closureDigest,
  isSafeTreePath,
  reachableMembers,
  scanReferences,
  treeDigest,
  treeManifestFromFiles,
} from '../src/index.js';

const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});
const nodeId = (character: string) => `sha256:${character.repeat(64)}`;
const bytes = (text: string) => new TextEncoder().encode(text);

describe('tree manifests', () => {
  it('carries executability in kind, not a mode integer', () => {
    const manifest = treeManifestFromFiles([
      { path: 'bin/greet', size: 12, digest: digest('a'), mode: 0o755 },
      { path: 'lib/libgreet.so', size: 40, digest: digest('b'), mode: 0o644 },
    ]);
    expect(manifest.entries.map((entry) => entry.kind)).toEqual([
      'executable',
      'file',
    ]);
    expect(manifest.entries.every((entry) => !('mode' in entry))).toBe(true);
  });

  it('digests identically regardless of how the tree was walked', async () => {
    const files = [
      { path: 'b.txt', size: 1, digest: digest('b'), mode: 0o644 },
      { path: 'a.txt', size: 1, digest: digest('a'), mode: 0o644 },
    ];
    const forward = await treeDigest(treeManifestFromFiles(files));
    const reversed = await treeDigest(
      treeManifestFromFiles([...files].reverse()),
    );
    expect(reversed.value).toBe(forward.value);
  });

  it('changes when any file content changes', async () => {
    const before = await treeDigest(
      treeManifestFromFiles([
        { path: 'a.txt', size: 1, digest: digest('a'), mode: 0o644 },
      ]),
    );
    const after = await treeDigest(
      treeManifestFromFiles([
        { path: 'a.txt', size: 1, digest: digest('c'), mode: 0o644 },
      ]),
    );
    expect(after.value).not.toBe(before.value);
  });

  it('records symlinks as representable but unmaterializable', () => {
    const manifest = treeManifestFromFiles(
      [{ path: 'bin/greet', size: 1, digest: digest('a'), mode: 0o755 }],
      { symlinks: [{ path: 'bin/hi', target: 'greet' }] },
    );
    expect(
      manifest.entries.find((entry) => entry.path === 'bin/hi')?.kind,
    ).toBe('symlink');
    expect(manifest.semanticLoss.map((item) => item.code)).toEqual([
      'TREE_ENTRY_UNSUPPORTED',
    ]);
  });

  it('refuses unsafe and duplicate paths', () => {
    for (const path of ['../escape', '/abs', 'a//b', 'a/./b', 'a\\b', 'a/'])
      expect(isSafeTreePath(path)).toBe(false);
    expect(isSafeTreePath('bin/greet')).toBe(true);

    expect(() =>
      treeManifestFromFiles([
        { path: '../escape', size: 1, digest: digest('a'), mode: 0o644 },
      ]),
    ).toThrow(/Unsafe/);
    expect(() =>
      treeManifestFromFiles([
        { path: 'a.txt', size: 1, digest: digest('a'), mode: 0o644 },
        { path: 'a.txt', size: 1, digest: digest('b'), mode: 0o644 },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe('reference scanning', () => {
  const candidates = [
    { token: 'c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n', nodeId: nodeId('2') },
    { token: 'z9z9z9z9z9z9z9z9z9z9z9z9z9z9z9z9', nodeId: nodeId('3') },
  ];

  it('finds a reference embedded in binary bytes', () => {
    // The token is surrounded by non-text bytes, as it would be inside an ELF.
    const payload = new Uint8Array([
      0x7f,
      0x45,
      0x4c,
      0x46,
      ...bytes('/nix/store/c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n-glibc-2.39/lib'),
      0x00,
      0xff,
    ]);
    const found = scanReferences(
      [{ path: 'bin/greet', data: payload }],
      candidates,
    );
    expect(found).toEqual([{ nodeId: nodeId('2'), paths: ['bin/greet'] }]);
  });

  it('does not report a self reference', () => {
    const data = bytes('c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n');
    expect(
      scanReferences([{ path: 'a', data }], candidates, {
        selfNodeId: nodeId('2'),
      }),
    ).toEqual([]);
  });

  it('reports every file a reference appears in', () => {
    const data = bytes('needs c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n here');
    const found = scanReferences(
      [
        { path: 'bin/a', data },
        { path: 'bin/b', data },
        { path: 'bin/c', data: bytes('nothing') },
      ],
      candidates,
    );
    expect(found[0]?.paths).toEqual(['bin/a', 'bin/b']);
  });
});

describe('closure assembly', () => {
  const members = [
    { nodeId: nodeId('1'), artifactDigest: digest('1') },
    { nodeId: nodeId('2'), artifactDigest: digest('2') },
  ];

  it('marks an edge both parties agree on as reconciled', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members,
      declaredEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('2') }],
      scannedEdges: [
        {
          fromNodeId: nodeId('1'),
          toNodeId: nodeId('2'),
          paths: ['bin/greet'],
        },
      ],
    });
    expect(closure.completeness).toBe('reconciled');
    expect(closure.edges[0]?.provenance).toBe('both');
    expect(closure.edges[0]?.evidenceRefs?.[0]?.locator).toBe('bin/greet');
    expect(closure.semanticLoss).toEqual([]);
  });

  it('keeps declared and observed knowledge distinguishable', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members,
      declaredEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('2') }],
      scannedEdges: [{ fromNodeId: nodeId('2'), toNodeId: nodeId('1') }],
    });
    const byProvenance = Object.fromEntries(
      closure.edges.map((edge) => [edge.provenance, true]),
    );
    expect(byProvenance).toEqual({ declared: true, scanned: true });
    // A declared edge nothing referenced is normal, and recorded as info.
    expect(closure.semanticLoss.map((item) => item.code)).toContain(
      'CLOSURE_EDGE_DECLARED_NOT_OBSERVED',
    );
  });

  it('treats a scanned edge with no member as an error', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members: [members[0]!],
      scannedEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('9') }],
    });
    // A closure missing a referenced member is incomplete for anyone copying it.
    expect(closure.semanticLoss.map((item) => item.code)).toContain(
      'CLOSURE_REFERENCE_UNRESOLVED',
    );
    expect(closure.completeness).not.toBe('reconciled');
    expect(closure.edges).toEqual([]);
  });

  it('says so when nothing was scanned', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members,
      declaredEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('2') }],
    });
    expect(closure.completeness).toBe('declared');
    expect(closure.semanticLoss.map((item) => item.code)).toContain(
      'CLOSURE_EDGES_DECLARED_ONLY',
    );
  });

  it('computes reachability as the least fixpoint', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members: [
        ...members,
        { nodeId: nodeId('3'), artifactDigest: digest('3') },
        { nodeId: nodeId('4'), artifactDigest: digest('4') },
      ],
      declaredEdges: [
        { fromNodeId: nodeId('1'), toNodeId: nodeId('2') },
        { fromNodeId: nodeId('2'), toNodeId: nodeId('3') },
        // 4 is a member but nothing reaches it: collectible.
      ],
    });
    const reachable = reachableMembers(closure);
    expect(reachable).toEqual([nodeId('1'), nodeId('2'), nodeId('3')]);
    expect(reachable).not.toContain(nodeId('4'));
  });

  it('terminates on a cyclic closure', () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('1')],
      members,
      declaredEdges: [
        { fromNodeId: nodeId('1'), toNodeId: nodeId('2') },
        { fromNodeId: nodeId('2'), toNodeId: nodeId('1') },
      ],
    });
    // Store references are routinely cyclic; the fixpoint must not spin.
    expect(reachableMembers(closure)).toEqual([nodeId('1'), nodeId('2')]);
  });

  it('digests independently of input ordering', async () => {
    const forward = assembleClosure({
      rootNodeIds: [nodeId('1'), nodeId('2')],
      members,
      declaredEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('2') }],
    });
    const reversed = assembleClosure({
      rootNodeIds: [nodeId('2'), nodeId('1')],
      members: [...members].reverse(),
      declaredEdges: [{ fromNodeId: nodeId('1'), toNodeId: nodeId('2') }],
    });
    expect((await closureDigest(reversed)).value).toBe(
      (await closureDigest(forward)).value,
    );
  });
});
