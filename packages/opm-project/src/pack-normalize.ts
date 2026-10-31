import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative as pathRelative,
  resolve,
  sep,
} from 'node:path';
import type {
  NormalizedPackFile,
  NormalizedPackInput,
} from '@openpacker/adapter-core';
import {
  canonicalBytes,
  canonicalDigest,
  compareCanonicalStrings,
  sha256,
} from '@openpacker/canonical';
import type {
  Digest,
  Distribution,
  JsonValue,
  NormalizedLifecycleHook,
  NormalizedOciConfig,
  PackageManifest,
  SemanticLoss,
  TreeManifest,
  TreeManifestEntry,
} from '@openpacker/contracts';
import { packTar } from '@openpacker/project-io';
import { OpmError } from './types.js';

const MAX_FILES = 100_000;
const MAX_BYTES = 1_073_741_824;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.opm', '.venv', 'node_modules']);

export interface NormalizedProjectPack extends NormalizedPackInput {
  bytes: Uint8Array;
  digest: Digest;
  layerBytes: Uint8Array;
}

/** Capture one project into the common OCI filesystem/config model. */
export async function normalizeProjectPack(input: {
  root: string;
  package: PackageManifest;
  target: Distribution;
  config?: Partial<NormalizedOciConfig>;
  lifecycle?: readonly NormalizedLifecycleHook[];
  nativeMetadata?: Record<string, JsonValue>;
  semanticLoss?: readonly SemanticLoss[];
  excludePaths?: readonly string[];
  includePaths?: readonly string[];
}): Promise<NormalizedProjectPack> {
  assertTarget(input.package, input.target);
  const capture = await captureProject(
    input.root,
    input.excludePaths ?? [],
    input.includePaths,
  );
  const files = capture.files;
  const treeEntries: TreeManifestEntry[] = [];
  for (const file of files) {
    const digest = await sha256(file.contents);
    treeEntries.push({
      path: file.path,
      kind: file.executable ? 'executable' : 'file',
      digest,
      size: file.contents.byteLength,
    });
  }
  const tree: TreeManifest = {
    manifestVersion: '1',
    entries: treeEntries,
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const treeDigest = await canonicalDigest(
    JSON.parse(JSON.stringify(tree)) as JsonValue,
  );
  const layerBytes = packTar(files);
  const layerDigest = await sha256(layerBytes);
  const config: NormalizedOciConfig = {
    entrypoint: input.config?.entrypoint ?? [],
    arguments: input.config?.arguments ?? [],
    environment: input.config?.environment ?? {},
    labels: {
      'org.opencontainers.image.title': input.package.name,
      'org.opencontainers.image.version': input.package.version,
      ...(!(input.target.exactPurl === undefined) && {
        'dev.openpacker.package.purl': input.target.exactPurl,
      }),
      ...input.config?.labels,
    },
    exposedPorts: input.config?.exposedPorts ?? [],
    volumes: input.config?.volumes ?? [],
    ...(!(input.config?.workingDirectory === undefined) && {
      workingDirectory: input.config.workingDirectory,
    }),
    ...(!(input.config?.user === undefined) && { user: input.config.user }),
    ...(!(input.config?.stopSignal === undefined) && {
      stopSignal: input.config.stopSignal,
    }),
  };
  const manifest = {
    normalizedPackManifestVersion: '1' as const,
    package: input.package,
    target: input.target,
    tree,
    oci: {
      imageLayoutVersion: '1.0.0' as const,
      config,
      layers: [
        {
          descriptorId: `sha256:${layerDigest.value}`,
          digest: layerDigest,
          size: layerBytes.byteLength,
          mediaType: 'application/vnd.oci.image.layer.v1.tar',
          artifactType: 'application/vnd.openpacker.normalized-source.v1.tar',
          nativeRole: 'normalized-source',
          locations: [],
          referrers: [],
          externalRefs: [],
          treeDigest,
        },
      ],
    },
    requirements: input.target.requirements ?? [],
    lifecycle: [...(input.lifecycle ?? [])],
    nativeMetadata: {
      'dev.openpacker.capture': 'project-tree-v1',
      ...input.nativeMetadata,
    },
    semanticLoss: [
      ...(input.semanticLoss ?? []),
      ...(capture.sensitiveExcluded.length === 0
        ? []
        : [sensitiveCaptureLoss(capture.sensitiveExcluded)]),
    ],
  };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const bytes = canonicalBytes(
    JSON.parse(JSON.stringify(manifest)) as JsonValue,
  );
  return {
    manifest,
    files,
    bytes,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    digest: await canonicalDigest(
      JSON.parse(JSON.stringify(manifest)) as JsonValue,
    ),
    layerBytes,
  };
}

async function captureProject(
  root: string,
  excludePaths: readonly string[],
  includePaths: readonly string[] | undefined,
): Promise<{
  files: NormalizedPackFile[];
  sensitiveExcluded: string[];
}> {
  const files: NormalizedPackFile[] = [];
  const sensitiveExcluded: string[] = [];
  const included =
    includePaths === undefined ? undefined : new Set(includePaths);
  const stableRoot = await realpath(root);
  // The walk names entries under the root's real path; an excluded path is
  // written under the root as it was given, which differs when the root is
  // reached through a link (a linked $TMPDIR, /var on macOS). Exclude both.
  const excluded = excludePaths.flatMap((path) => {
    const written = resolve(path);
    const inside = pathRelative(resolve(root), written);
    // `..` alone or followed by a separator leaves the root; `..dist` is a
    // name inside it.
    return inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
      ? [written]
      : [written, join(stableRoot, inside)];
  });
  const directories = new Map<string, DirectorySnapshot>();
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const directoryBefore = await stableDirectory(
      stableRoot,
      directory,
      prefix,
      directories,
    );
    const entries = await readdir(directory, { withFileTypes: true });
    const directoryAfter = await stableDirectory(
      stableRoot,
      directory,
      prefix,
      directories,
    );
    if (!sameDirectory(directoryBefore, directoryAfter)) changed(prefix || '.');
    entries.sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = resolve(directory, entry.name);
      if (
        excluded.some(
          (path) => absolute === path || absolute.startsWith(`${path}${sep}`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name))
          await walk(join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (included !== undefined && !included.has(relative)) continue;
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        sensitiveExcluded.push(relative);
        continue;
      }
      const path = join(directory, entry.name);
      await assertContained(stableRoot, path, relative);
      const pathBefore = await lstat(path, { bigint: true });
      if (!pathBefore.isFile())
        throw new OpmError(
          'PACK_INPUT_CHANGED',
          `Pack input changed while capturing ${relative}`,
        );
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.dev !== pathBefore.dev ||
          before.ino !== pathBefore.ino
        )
          throw new OpmError(
            'PACK_INPUT_CHANGED',
            `Pack input changed while capturing ${relative}`,
          );
        await assertContained(stableRoot, path, relative);
        total += Number(before.size);
        if (files.length >= MAX_FILES || total > MAX_BYTES)
          throw new OpmError(
            'PACK_INPUT_TOO_LARGE',
            `Normalized pack input exceeds ${MAX_FILES} files or ${MAX_BYTES} bytes`,
          );
        const contents = new Uint8Array(await handle.readFile());
        const after = await handle.stat({ bigint: true });
        const pathAfter = await lstat(path, { bigint: true });
        await assertContained(stableRoot, path, relative);
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          after.dev !== pathAfter.dev ||
          after.ino !== pathAfter.ino ||
          contents.byteLength !== Number(after.size)
        )
          throw new OpmError(
            'PACK_INPUT_CHANGED',
            `Pack input changed while capturing ${relative}`,
          );
        files.push({
          path: relative,
          contents,
          executable: (Number(after.mode) & 0o111) !== 0,
        });
      } finally {
        await handle.close();
      }
    }
  };
  try {
    await walk(stableRoot, '');
    for (const [directory, snapshot] of directories) {
      const after = await directorySnapshot(
        stableRoot,
        directory,
        snapshot.displayPath,
      );
      if (!sameDirectory(snapshot, after)) changed(snapshot.displayPath);
    }
  } catch (error) {
    if (error instanceof OpmError) throw error;
    changed('.', error);
  }
  return { files, sensitiveExcluded };
}

interface DirectorySnapshot {
  displayPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

async function stableDirectory(
  root: string,
  directory: string,
  displayPath: string,
  snapshots: Map<string, DirectorySnapshot>,
): Promise<DirectorySnapshot> {
  const snapshot = await directorySnapshot(root, directory, displayPath || '.');
  const previous = snapshots.get(directory);
  if (previous !== undefined && !sameDirectory(previous, snapshot))
    changed(displayPath || '.');
  snapshots.set(directory, snapshot);
  return snapshot;
}

async function directorySnapshot(
  root: string,
  directory: string,
  displayPath: string,
): Promise<DirectorySnapshot> {
  await assertContained(root, directory, displayPath || '.');
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) changed(displayPath || '.');
  return {
    displayPath,
    dev: info.dev,
    ino: info.ino,
    ctimeNs: info.ctimeNs,
    mtimeNs: info.mtimeNs,
  };
}

function sameDirectory(
  left: DirectorySnapshot,
  right: DirectorySnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

async function assertContained(
  root: string,
  path: string,
  displayPath: string,
): Promise<void> {
  if (resolve(path) === root) {
    if ((await realpath(path)) !== root) changed(displayPath);
    return;
  }
  const relative = pathRelative(root, path);
  if (relative === '..' || relative.startsWith(`..${sep}`))
    changed(displayPath);
  let current = root;
  const ancestor = pathRelative(root, dirname(path));
  for (const part of ancestor === '' ? [] : ancestor.split(sep)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) changed(displayPath);
  }
  const resolved = await realpath(path);
  const resolvedRelative = pathRelative(root, resolved);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`))
    changed(displayPath);
}

function changed(path: string, cause?: unknown): never {
  throw new OpmError(
    'PACK_INPUT_CHANGED',
    `Pack input changed while capturing ${path}${
      cause instanceof Error ? `: ${cause.message}` : ''
    }`,
  );
}

function assertTarget(pack: PackageManifest, target: Distribution): void {
  if (
    !pack.distributions.some(
      (candidate) =>
        candidate.purlType === target.purlType &&
        candidate.identifier === target.identifier &&
        candidate.version === target.version,
    )
  )
    throw new OpmError(
      'INVALID_TARGET',
      `Target ${target.purlType}:${target.identifier}@${target.version} is not declared by the package manifest`,
    );
}

/** Stable short id for receipt and fixture naming. */
export function normalizedPackId(input: NormalizedProjectPack): string {
  return createHash('sha256').update(input.bytes).digest('hex').slice(0, 16);
}

function sensitiveCaptureLoss(paths: readonly string[]): SemanticLoss {
  return {
    code: 'NORMALIZED_SENSITIVE_FILES_EXCLUDED',
    severity: 'warning',
    sourceEcosystem: 'normalized',
    sourcePath: '/',
    originalMeaning: `${paths.length} environment file(s) exist in the project tree`,
    representedMeaning:
      'The normalized package tree excludes environment files',
    omittedMeaning: paths.join(', '),
    mitigation: 'Move intentional package data out of .env files',
    blocksProfile: ['native-capture-v1'],
  };
}
