import * as ahocorasick from 'ahocorasick';
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

/**
 * Windows device names, which are reserved at every directory level and stay
 * reserved with an extension: `CON`, `CON.txt` and `con.tar.gz` are all the
 * console, not files. Writing a package entry called `NUL` on Windows
 * discards it silently.
 */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

/**
 * A segment Windows would silently rewrite.
 *
 * Trailing dots and spaces are stripped when a path is resolved, so `a.` and
 * `a` name one file there and two here — which would defeat the duplicate and
 * case-collision checks that make a tree manifest unambiguous.
 */
const WINDOWS_TRAILING = /[ .]$/u;

export function isSafeTreePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/')) return false;
  if (value.includes('\\') || CONTROL.test(value)) return false;
  return value.split('/').every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      // Checked on every platform, not just Windows: a manifest is a
      // portable description, and a tree that only materializes safely on
      // Linux is not one.
      !WINDOWS_DEVICE.test(segment) &&
      !WINDOWS_TRAILING.test(segment),
  );
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(manifest)) as JsonValue,
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
      token: latin1(encoder.encode(candidate.token)),
    }))
    .filter((candidate) => candidate.token.length > 0);
  if (needles.length === 0) return [];

  // Aho-Corasick, not a rolling hash. It matches every candidate in one pass
  // regardless of how many there are or how their lengths vary, and — the
  // reason it is worth a dependency — it compares bytes rather than hashes, so
  // a false positive from a hash collision is not a thing that can happen. The
  // hand-written Rabin-Karp it replaced needed a deliberately constructed
  // collision to demonstrate it was safe; this needs no such argument.
  const byToken = new Map<string, string[]>();
  for (const needle of needles)
    byToken.set(needle.token, [
      ...(byToken.get(needle.token) ?? []),
      needle.nodeId,
    ]);
  // The package ships a CommonJS constructor and this repository does not
  // enable esModuleInterop, so the namespace object is the constructor under
  // CJS and carries it on `default` once an ESM loader has wrapped it.
  type Automaton = new (keywords: readonly string[]) => {
    search(text: string): [number, string[]][];
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const namespace = ahocorasick as unknown as {
    default?: Automaton;
  } & Automaton;
  const AhoCorasick: Automaton = namespace.default ?? namespace;
  const automaton = new AhoCorasick([...byToken.keys()]);

  const found = new Map<string, Set<string>>();
  for (const file of files)
    for (const [, matched] of automaton.search(latin1(file.data)))
      for (const token of Array.isArray(matched) ? matched : [matched])
        for (const nodeId of byToken.get(token) ?? []) {
          const paths = found.get(nodeId) ?? new Set<string>();
          paths.add(file.path);
          found.set(nodeId, paths);
        }
  return [...found.entries()]
    .map(([nodeId, paths]) => ({ nodeId, paths: [...paths].sort() }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
}

const encoder = new TextEncoder();

/**
 * Bytes as a string, one character per byte.
 *
 * The scan runs over binaries, so the bytes are not necessarily UTF-8 and
 * decoding them as such would corrupt them. Latin-1 is the identity mapping
 * between bytes and code points 0..255, which keeps matching byte-exact while
 * letting a string-oriented matcher do the work.
 */
function latin1(bytes: Uint8Array): string {
  // Node's native decoder is ~110x faster than the portable loop on an 8MB
  // artifact (4ms against 441ms), which is most of this scan's cost, so it is
  // worth branching for. Both produce identical strings.
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const buffer = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer;
  if (buffer !== undefined)
    return buffer
      .from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString('latin1');
  // Chunked because `String.fromCharCode` takes arguments on the stack, and a
  // multi-megabyte artifact would overflow it.
  const CHUNK = 0x8000;
  let out = '';
  for (let index = 0; index < bytes.length; index += CHUNK)
    out += String.fromCharCode(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ...(bytes.subarray(index, index + CHUNK) as unknown as number[]),
    );
  return out;
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
      ...(!(paths.length === 0) && {
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(closure)) as JsonValue,
    projectionFor('closure-v1'),
  );
}
