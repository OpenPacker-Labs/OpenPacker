import { describe, expect, it } from 'vitest';
import { canonicalProjectionDigest } from '@openpacker/canonical';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';
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

describe('scanner equivalence and scaling', () => {
  // The obvious implementation, kept as an oracle. The fast scanner must agree
  // with it exactly. It stays after the move to a library matcher: the value
  // now is catching a wrong adaptation — the byte-to-latin1 mapping, overlap
  // handling, or the token-to-nodeId fan-out — rather than wrong arithmetic.
  const naiveScan = (
    files: readonly { path: string; data: Uint8Array }[],
    candidates: readonly { token: string; nodeId: string }[],
  ) => {
    const found = new Map<string, Set<string>>();
    for (const file of files)
      for (const candidate of candidates) {
        const needle = new TextEncoder().encode(candidate.token);
        outer: for (let i = 0; i + needle.length <= file.data.length; i += 1) {
          for (let j = 0; j < needle.length; j += 1)
            if (file.data[i + j] !== needle[j]) continue outer;
          const paths = found.get(candidate.nodeId) ?? new Set<string>();
          paths.add(file.path);
          found.set(candidate.nodeId, paths);
          break;
        }
      }
    return [...found.entries()]
      .map(([nodeId, paths]) => ({ nodeId, paths: [...paths].sort() }))
      .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
  };

  it('agrees with the naive scanner on adversarial data', () => {
    // A deterministic PRNG so a failure is reproducible. An LCG's low bits
    // have period equal to their modulus, so `lcg() % 2` alternates and
    // `% 16` repeats every sixteen — drawing from a small alphabet that way
    // produces strictly periodic "random" data. This finalizes with murmur3's
    // avalanche step instead, which mixes every bit.
    let counter = 0x2f6e2b1;
    const next = () => {
      counter = (counter + 0x9e3779b9) >>> 0;
      let value = counter;
      value ^= value >>> 16;
      value = Math.imul(value, 0x85ebca6b) >>> 0;
      value ^= value >>> 13;
      value = Math.imul(value, 0xc2b2ae35) >>> 0;
      return (value ^ (value >>> 16)) >>> 0;
    };
    for (let round = 0; round < 40; round += 1) {
      // A tiny alphabet maximises accidental partial matches and overlapping
      // candidates — where a matcher is most likely to lose or double-count.
      const alphabet = round % 2 === 0 ? 'ab' : '0123456789abcdef';
      const draw = (length: number) =>
        Array.from({ length }, () => alphabet[next() % alphabet.length]!).join(
          '',
        );

      const candidates = Array.from({ length: 8 }, (_, index) => ({
        // Mixed token lengths exercise the per-length index.
        token: draw(2 + (index % 5)),
        nodeId: `sha256:${String(index).padStart(64, '0')}`,
      }));
      const files = Array.from({ length: 3 }, (_, index) => ({
        path: `file-${index}`,
        data: new TextEncoder().encode(draw(200)),
      }));
      // The corpus has to be aperiodic or this compares two scanners over a
      // handful of repeating bytes and proves nothing.
      const text = new TextDecoder().decode(files[0]!.data);
      for (const period of [1, 2, 4, 8, 16])
        expect(
          text
            .slice(0, period)
            .repeat(Math.ceil(200 / period))
            .slice(0, 200),
          `round ${round} corpus is periodic with period ${period}`,
        ).not.toBe(text);
      expect(scanReferences(files, candidates), `round ${round}`).toEqual(
        naiveScan(files, candidates),
      );
    }
  });

  it('finds a needle at the very start and very end of a file', () => {
    // Boundary positions are where an off-by-one in the roll would hide.
    const candidates = [
      { token: 'HEAD', nodeId: `sha256:${'1'.repeat(64)}` },
      { token: 'TAIL', nodeId: `sha256:${'2'.repeat(64)}` },
    ];
    const data = new TextEncoder().encode('HEADmiddleTAIL');
    expect(scanReferences([{ path: 'f', data }], candidates)).toEqual([
      { nodeId: `sha256:${'1'.repeat(64)}`, paths: ['f'] },
      { nodeId: `sha256:${'2'.repeat(64)}`, paths: ['f'] },
    ]);
    // A needle exactly as long as the file is still found.
    expect(
      scanReferences(
        [{ path: 'f', data: new TextEncoder().encode('HEAD') }],
        candidates,
      ),
    ).toEqual([{ nodeId: `sha256:${'1'.repeat(64)}`, paths: ['f'] }]);
    // A needle longer than the file is not.
    expect(
      scanReferences(
        [{ path: 'f', data: new TextEncoder().encode('HEA') }],
        candidates,
      ),
    ).toEqual([]);
  });

  it('stays fast as the candidate set grows', () => {
    // The point of the rewrite: cost tracks bytes, not candidates. The old
    // scanner took ~8s for this shape.
    const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
    // Each character takes five *high* bits of a mixed value. Taking `% 32` of
    // an LCG uses its low five bits, whose period is 32 — that produced 32
    // distinct tokens, all rotations of one string, rather than 1000.
    const candidates = Array.from({ length: 1000 }, (_, index) => {
      let token = '';
      for (let i = 0; i < 32; i += 1) {
        let value =
          (Math.imul(index + 1, 0x9e3779b9) + Math.imul(i, 0x85ebca6b)) >>> 0;
        value ^= value >>> 16;
        value = Math.imul(value, 0x85ebca6b) >>> 0;
        value ^= value >>> 13;
        value = Math.imul(value, 0xc2b2ae35) >>> 0;
        token += alphabet[(value >>> 27) % 32]!;
      }
      return { token, nodeId: `sha256:${String(index).padStart(64, '0')}` };
    });
    // The point of the benchmark is a large candidate set, so it has to
    // actually be one.
    expect(new Set(candidates.map(({ token }) => token)).size).toBe(1000);
    const data = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < data.length; index += 1)
      data[index] = 48 + (index % 10);
    const started = Date.now();
    expect(scanReferences([{ path: 'big', data }], candidates)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
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

describe('digests agree with the spec projections', () => {
  const projectionFor = (id: string) => {
    const projection = DIGEST_PROJECTIONS.projections.find(
      (item) => item.id === id,
    );
    if (!projection) throw new Error(id);
    return projection;
  };

  it('tree digests equal tree-manifest-v1, including unsorted loss entries', async () => {
    // semanticLoss is an ordered set in the projection, so a manifest whose
    // losses arrive out of order must still digest the same.
    const manifest = treeManifestFromFiles(
      [{ path: 'bin/greet', size: 1, digest: digest('a'), mode: 0o755 }],
      {
        symlinks: [
          { path: 'zzz', target: 'greet' },
          { path: 'aaa', target: 'greet' },
        ],
      },
    );
    expect(manifest.semanticLoss.length).toBe(2);
    expect((await treeDigest(manifest)).value).toBe(
      (
        await canonicalProjectionDigest(
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          manifest as never,
          projectionFor('tree-manifest-v1'),
        )
      ).value,
    );
  });

  it('closure digests equal closure-v1', async () => {
    const closure = assembleClosure({
      rootNodeIds: [nodeId('2'), nodeId('1')],
      members: [
        { nodeId: nodeId('2'), artifactDigest: digest('2') },
        { nodeId: nodeId('1'), artifactDigest: digest('1') },
      ],
      declaredEdges: [
        { fromNodeId: nodeId('2'), toNodeId: nodeId('1') },
        { fromNodeId: nodeId('1'), toNodeId: nodeId('2') },
      ],
    });
    expect((await closureDigest(closure)).value).toBe(
      (
        await canonicalProjectionDigest(
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          closure as never,
          projectionFor('closure-v1'),
        )
      ).value,
    );
  });
});

describe('tree paths are portable, not merely POSIX-safe', () => {
  it('refuses Windows device names at any depth', () => {
    for (const path of ['CON', 'aux.txt', 'lib/NUL', 'COM1/x', 'a/lpt3'])
      expect(isSafeTreePath(path), path).toBe(false);
  });

  it('refuses a trailing dot or space, which Windows strips', () => {
    // "a." and "a" name one file on Windows and two here, which would defeat
    // the duplicate and case-collision checks that make a manifest unambiguous.
    for (const path of ['a.', 'a ', 'dir./file'])
      expect(isSafeTreePath(path), path).toBe(false);
  });

  it('still accepts ordinary names that begin with a device name', () => {
    for (const path of ['console.js', 'lib/context.ts', 'nullable.d.ts'])
      expect(isSafeTreePath(path), path).toBe(true);
  });
});
