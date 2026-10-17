/**
 * The `.tgz` npm publishes, and which files go in it.
 *
 * npm's `files`/`.npmignore` rules decide what ships. They are honoured here
 * for the parts that are data — the `files` allowlist and npm's always-
 * include and always-exclude sets — and a project relying on `.npmignore`
 * gets that read too. What is not attempted is npm's full precedence
 * behaviour; where this differs it says so rather than quietly shipping a
 * different set of files.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DetectedProject,
  PackProjectOptions,
  PackedArtifact,
} from '@openpacker/adapter-core';
import {
  collectFiles,
  packTarGzip,
  ProjectIoError,
  writeFileAtomic,
} from '@openpacker/project-io';
import { packLoss } from './project-losses.js';
import { purlForName } from './purl.js';

/** The parts of `package.json` a pack reads. */
interface PackManifest {
  name?: string;
  version?: string;
  files?: string[];
}

export async function packNpmProject(
  project: DetectedProject,
  options: PackProjectOptions = {},
): Promise<PackedArtifact> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const manifest = JSON.parse(
    await readFile(project.manifestPath, 'utf8'),
  ) as PackManifest;
  const name = manifest.name ?? 'package';
  const version = manifest.version ?? '0.0.0';

  const all = await collectFiles(project.root);
  const publishPaths = new Set(await npmPublishPaths(project));
  const included = all.filter((file) => publishPaths.has(file.path));

  // npm archives put everything under `package/`.
  const bytes = packTarGzip(
    included.map((file) => ({
      path: `package/${file.path}`,
      contents: file.contents,
      executable: file.executable,
    })),
  );

  const fileName = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
  assertPackFileName(fileName, project.manifestPath);
  const outputPath = join(options.outputDirectory ?? project.root, fileName);
  await writeFileAtomic(outputPath, bytes);

  return {
    path: outputPath,
    exactPurl: `${purlForName(name)}@${version}`,
    mediaType: 'application/vnd.npm.install-v1+json',
    size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    semanticLoss: [packLoss()],
  };
}

function assertPackFileName(fileName: string, manifestPath: string): void {
  if (
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  )
    throw new ProjectIoError(
      'UNSAFE_PATH',
      manifestPath,
      `Package metadata produced an unsafe artifact filename: ${fileName}`,
    );
}

/** Paths npm never publishes, whatever the manifest says. */
const NEVER_PUBLISH = new Set([
  '.git',
  '.npmrc',
  'node_modules',
  'package-lock.json',
  '.opm',
]);

/** Paths npm always publishes, whatever `files` says. */
const ALWAYS_PUBLISH = [
  /^package\.json$/u,
  /^readme(\.|$)/iu,
  /^licen[cs]e(\.|$)/iu,
  /^changelog(\.|$)/iu,
];

/** The exact project paths OpenPacker's npm implementation may publish. */
export async function npmPublishPaths(
  project: DetectedProject,
): Promise<readonly string[]> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const manifest = JSON.parse(
    await readFile(project.manifestPath, 'utf8'),
  ) as PackManifest;
  const ignore = await readIgnoreFile(project.root);
  return (await listFilePaths(project.root)).filter((path) =>
    shouldPublish(path, manifest.files, ignore),
  );
}

async function listFilePaths(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const paths: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (prefix === '' && NEVER_PUBLISH.has(entry.name)) continue;
        await walk(join(directory, entry.name), path);
      } else if (entry.isFile()) paths.push(path);
    }
  };
  await walk(root, '');
  return paths;
}

async function readIgnoreFile(root: string): Promise<string[]> {
  const { readFile: read } = await import('node:fs/promises');
  for (const name of ['.npmignore', '.gitignore']) {
    try {
      return (await read(join(root, name), 'utf8'))
        .split(/\r?\n/u)
        .map((line) => line.split('#')[0]!.trim())
        .filter((line) => line !== '');
    } catch {
      // try the next one
    }
  }
  return [];
}

function shouldPublish(
  path: string,
  files: readonly string[] | undefined,
  ignore: readonly string[],
): boolean {
  const first = path.split('/')[0]!;
  if (NEVER_PUBLISH.has(first)) return false;
  if (ALWAYS_PUBLISH.some((pattern) => pattern.test(path))) return true;
  if (files && files.length > 0)
    return files.some(
      (entry) =>
        path === entry ||
        path.startsWith(`${entry.replace(/\/$/u, '')}/`) ||
        first === entry,
    );
  return !ignore.some(
    (entry) =>
      path === entry ||
      first === entry.replace(/\/$/u, '') ||
      path.startsWith(`${entry.replace(/\/$/u, '')}/`),
  );
}
