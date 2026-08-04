import { canonicalProjectionDigest } from '@openpacker/canonical';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';
import type { Digest, JsonValue, SemanticLoss } from '@openpacker/contracts';
import type { MaterializedFile } from '@openpacker/materializer';

/**
 * Tree manifests, reference scanning, and closure assembly.
 *
 * Scanning reads artifact bytes; it never executes them. That distinction is
 * normative (see invariant 10 in `spec/prex/v1/normative.md`), because a
 * reference scanner is the one thing in this area that could be mistaken for
 * a build step.
 */

export type TreeEntryKind = 'file' | 'executable' | 'directory' | 'symlink';

export interface TreeEntry {
  path: string;
  kind: TreeEntryKind;
  digest?: Digest;
  size?: number;
  target?: string;
}

export interface TreeManifest {
  manifestVersion: '1';
  entries: TreeEntry[];
  semanticLoss: SemanticLoss[];
}

/**
 * A materialized file, as the materializer reports it.
 *
 * Aliased to the real type rather than restated, so a change there is a
 * compile error here instead of silent divergence.
 */
export type MaterializedFileLike = MaterializedFile;

const CONTROL = /[\u0000-\u001f\u007f]/u;

export function isSafeTreePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/')) return false;
  if (value.includes('\\') || CONTROL.test(value)) return false;
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Build a tree manifest from materialized files. Executability is carried by
 * `kind` rather than a mode integer so that identical trees digest identically
 * across platforms that report modes differently.
 */
export function treeManifestFromFiles(
  files: readonly MaterializedFileLike[],
  options: { symlinks?: readonly { path: string; target: string }[] } = {},
): TreeManifest {
  const semanticLoss: SemanticLoss[] = [];
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeTreePath(file.path))
      throw new Error(`Unsafe tree manifest path: ${file.path}`);
    if (seen.has(file.path))
      throw new Error(`Duplicate tree manifest path: ${file.path}`);
    seen.add(file.path);
    entries.push({
      path: file.path,
      kind: (file.mode & 0o111) === 0 ? 'file' : 'executable',
      digest: file.digest,
      size: file.size,
    });
  }
  for (const link of options.symlinks ?? []) {
    if (!isSafeTreePath(link.path))
      throw new Error(`Unsafe tree manifest path: ${link.path}`);
    if (seen.has(link.path))
      throw new Error(`Duplicate tree manifest path: ${link.path}`);
    seen.add(link.path);
    entries.push({ path: link.path, kind: 'symlink', target: link.target });
    // Representable so a capture stays faithful, but this implementation will
    // not materialize it.
    semanticLoss.push({
      code: 'TREE_ENTRY_UNSUPPORTED',
      severity: 'warning',
      sourceEcosystem: 'prex',
      sourcePath: `/entries/${link.path}`,
      originalMeaning: `the tree contains a symlink at ${link.path}`,
      representedMeaning:
        'recorded in the manifest; this implementation does not materialize symlinks',
      blocksProfile: [],
    });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : 1));
  return { manifestVersion: '1', entries, semanticLoss };
}

function projectionFor(id: string) {
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === id,
  );
  if (!projection) throw new Error(`Unknown digest projection: ${id}`);
  return projection;
}

/**
 * `tree-manifest-v1` digest of a manifest.
 *
 * Computed through the shared projection machinery rather than a local sort,
 * so this agrees with any other conforming implementation by construction.
 */
export async function treeDigest(manifest: TreeManifest): Promise<Digest> {
  return canonicalProjectionDigest(
    manifest as unknown as JsonValue,
    projectionFor('tree-manifest-v1'),
  );
}

export interface ScanCandidate {
  /** The token that appears inside referring bytes, e.g. a store hash. */
  token: string;
  nodeId: string;
}

export interface ScannedReference {
  nodeId: string;
  /** Where the token was found, for evidence. */
  paths: string[];
}

/**
 * Scan materialized bytes for candidate reference tokens.
 *
 * This is what makes a closure observed rather than merely declared: Nix
 * discovers runtime references exactly this way, by looking for store hashes
 * embedded in the output. Tokens are matched as raw bytes so the scan works on
 * binaries, not only text.
 */
export function scanReferences(
  files: readonly { path: string; data: Uint8Array }[],
  candidates: readonly ScanCandidate[],
  options: { selfNodeId?: string } = {},
): ScannedReference[] {
  const needles = candidates
    .filter((candidate) => candidate.nodeId !== options.selfNodeId)
    .map((candidate) => ({
      nodeId: candidate.nodeId,
      bytes: encoder.encode(candidate.token),
    }))
    .filter((candidate) => candidate.bytes.length > 0);
  if (needles.length === 0) return [];

  // One index per distinct needle length. A real closure has thousands of
  // store hashes of one length, so this is a single pass over the bytes
  // rather than one pass per candidate.
  const byLength = new Map<number, Map<number, typeof needles>>();
  for (const needle of needles) {
    const index = byLength.get(needle.bytes.length) ?? new Map();
    const hash = rollingHash(needle.bytes, 0, needle.bytes.length);
    index.set(hash, [...(index.get(hash) ?? []), needle]);
    byLength.set(needle.bytes.length, index);
  }

  const found = new Map<string, Set<string>>();
  for (const file of files) {
    for (const [length, index] of byLength) {
      if (file.data.length < length) continue;
      // Rabin-Karp: hash each window once, and compare bytes only when a
      // hash matches, so a collision costs a comparison rather than a wrong
      // answer.
      const shift = powerOfBase(length - 1);
      let hash = rollingHash(file.data, 0, length);
      const limit = file.data.length - length;
      for (let start = 0; ; start += 1) {
        for (const needle of index.get(hash) ?? [])
          if (matchesAt(file.data, start, needle.bytes)) {
            const paths = found.get(needle.nodeId) ?? new Set<string>();
            paths.add(file.path);
            found.set(needle.nodeId, paths);
          }
        if (start === limit) break;
        hash = rollForward(
          hash,
          file.data[start]!,
          file.data[start + length]!,
          shift,
        );
      }
    }
  }
  return [...found.entries()]
    .map(([nodeId, paths]) => ({ nodeId, paths: [...paths].sort() }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
}

const encoder = new TextEncoder();

/** Multiplier for the rolling hash; arithmetic is exact modulo 2^32. */
const BASE = 16_777_619;

function rollingHash(bytes: Uint8Array, start: number, length: number): number {
  let hash = 0;
  for (let index = start; index < start + length; index += 1)
    hash = (Math.imul(hash, BASE) + bytes[index]!) >>> 0;
  return hash;
}

function powerOfBase(exponent: number): number {
  let value = 1;
  for (let index = 0; index < exponent; index += 1)
    value = Math.imul(value, BASE) >>> 0;
  return value;
}

function rollForward(
  hash: number,
  leaving: number,
  entering: number,
  shift: number,
): number {
  const without = (hash - Math.imul(leaving, shift)) >>> 0;
  return (Math.imul(without, BASE) + entering) >>> 0;
}

function matchesAt(
  haystack: Uint8Array,
  start: number,
  needle: Uint8Array,
): boolean {
  for (let offset = 0; offset < needle.length; offset += 1)
    if (haystack[start + offset] !== needle[offset]) return false;
  return true;
}

export interface ClosureMember {
  nodeId: string;
  exactPurl?: string;
  artifactDigest: Digest;
  treeDigest?: Digest;
  outputName?: string;
}

export interface ClosureEdge {
  fromNodeId: string;
  toNodeId: string;
  provenance: 'declared' | 'scanned' | 'both';
  evidenceRefs?: { type: string; locator: string }[];
}

export interface RuntimeClosure {
  closureVersion: '1';
  rootNodeIds: string[];
  members: ClosureMember[];
  edges: ClosureEdge[];
  completeness: 'declared' | 'scanned' | 'reconciled';
  semanticLoss: SemanticLoss[];
}

export interface ClosureInput {
  rootNodeIds: readonly string[];
  members: readonly ClosureMember[];
  declaredEdges?: readonly { fromNodeId: string; toNodeId: string }[];
  scannedEdges?: readonly {
    fromNodeId: string;
    toNodeId: string;
    paths?: readonly string[];
  }[];
}

const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

function loss(
  code: string,
  severity: SemanticLoss['severity'],
  sourcePath: string,
  originalMeaning: string,
  representedMeaning: string,
): SemanticLoss {
  return {
    code,
    severity,
    sourceEcosystem: 'prex',
    sourcePath,
    originalMeaning,
    representedMeaning,
    blocksProfile: [],
  };
}

/**
 * Assemble a closure, reconciling declared metadata edges against edges
 * observed in bytes.
 *
 * The two are different knowledge and stay distinguishable: a declared edge
 * that no bytes reference is normal (metadata is often conservative), while a
 * scanned edge with no member is an error, because the closure would be
 * incomplete for anyone who copied it.
 */
export function assembleClosure(input: ClosureInput): RuntimeClosure {
  const members = [...input.members].sort((left, right) =>
    left.nodeId < right.nodeId ? -1 : 1,
  );
  const known = new Set(members.map((member) => member.nodeId));
  const semanticLoss: SemanticLoss[] = [];

  const declared = new Set(
    (input.declaredEdges ?? []).map((edge) =>
      edgeKey(edge.fromNodeId, edge.toNodeId),
    ),
  );
  const scanned = new Map<string, readonly string[]>();
  for (const edge of input.scannedEdges ?? [])
    scanned.set(edgeKey(edge.fromNodeId, edge.toNodeId), edge.paths ?? []);

  const edges: ClosureEdge[] = [];
  for (const key of new Set([...declared, ...scanned.keys()])) {
    const [fromNodeId = '', toNodeId = ''] = key.split('\u0000');
    const isDeclared = declared.has(key);
    const isScanned = scanned.has(key);
    if (!known.has(toNodeId)) {
      semanticLoss.push(
        loss(
          'CLOSURE_REFERENCE_UNRESOLVED',
          'error',
          `/edges/${toNodeId}`,
          `an edge points at ${toNodeId}`,
          'the target is not a member of this closure',
        ),
      );
      continue;
    }
    if (isDeclared && !isScanned)
      semanticLoss.push(
        loss(
          'CLOSURE_EDGE_DECLARED_NOT_OBSERVED',
          'info',
          `/edges/${fromNodeId}`,
          `metadata declares a runtime edge to ${toNodeId}`,
          'no reference to it was observed in the realised bytes',
        ),
      );
    const paths = scanned.get(key) ?? [];
    edges.push({
      fromNodeId,
      toNodeId,
      provenance:
        isDeclared && isScanned ? 'both' : isDeclared ? 'declared' : 'scanned',
      ...(paths.length === 0
        ? {}
        : {
            evidenceRefs: paths.map((path) => ({
              type: 'reference-scan',
              locator: path,
            })),
          }),
    });
  }
  edges.sort((left, right) =>
    edgeKey(left.fromNodeId, left.toNodeId) <
    edgeKey(right.fromNodeId, right.toNodeId)
      ? -1
      : 1,
  );

  const hasScanned = (input.scannedEdges ?? []).length > 0;
  const hasDeclared = (input.declaredEdges ?? []).length > 0;
  const unresolved = semanticLoss.some(
    (item) => item.code === 'CLOSURE_REFERENCE_UNRESOLVED',
  );
  let completeness: RuntimeClosure['completeness'];
  if (hasScanned && hasDeclared && !unresolved) completeness = 'reconciled';
  else if (hasScanned && !hasDeclared) completeness = 'scanned';
  else completeness = 'declared';
  if (completeness === 'declared' && !hasScanned)
    semanticLoss.push(
      loss(
        'CLOSURE_EDGES_DECLARED_ONLY',
        'warning',
        '/edges',
        'the closure was built from declared metadata alone',
        'no realised bytes were scanned, so unobserved references may exist',
      ),
    );

  return {
    closureVersion: '1',
    rootNodeIds: [...input.rootNodeIds].sort(),
    members,
    edges,
    completeness,
    semanticLoss,
  };
}

/**
 * The members reachable from `roots` under the closure's edges: the least
 * fixpoint the specification defines. Collection uses its complement.
 */
export function reachableMembers(
  closure: RuntimeClosure,
  roots: readonly string[] = closure.rootNodeIds,
): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of closure.edges) {
    const list = outgoing.get(edge.fromNodeId) ?? [];
    list.push(edge.toNodeId);
    outgoing.set(edge.fromNodeId, list);
  }
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next);
  }
  return [...seen].sort();
}

/** `closure-v1` digest of an assembled closure. */
export async function closureDigest(closure: RuntimeClosure): Promise<Digest> {
  return canonicalProjectionDigest(
    closure as unknown as JsonValue,
    projectionFor('closure-v1'),
  );
}
