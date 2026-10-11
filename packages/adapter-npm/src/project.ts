/**
 * `package.json` as a PREX project format.
 *
 * Everything else in a Node project — the IDE, `node`, CI, every other tool —
 * reads `package.json`. If `opm add` does not put the dependency there, opm and
 * the rest of the toolchain disagree about what the project needs.
 */

import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DetectedProject,
  NativeLockEntry,
  NativeRequirement,
  PackProjectOptions,
  PackedArtifact,
  ProjectFormat,
  ProjectionResult,
  RequirementScope,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import {
  collectFiles,
  editJsonFile,
  packTarGzip,
  ProjectIoError,
  writeFileAtomic,
} from '@openpacker/project-io';
import { writeNodeModules, type LayoutOutcome } from './layout-write.js';

/** Where each scope lives in package.json. */
const SCOPE_FIELD = {
  runtime: 'dependencies',
  development: 'devDependencies',
  optional: 'optionalDependencies',
  peer: 'peerDependencies',
  // npm has no build-time dependency class distinct from devDependencies, and
  // pretending otherwise would silently move a requirement.
  build: undefined,
};

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

interface PackageJson {
  name?: string;
  version?: string;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export class NpmProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.npm';
  readonly purlType = 'npm' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const manifestPath = join(root, 'package.json');
    try {
      await access(manifestPath);
    } catch {
      return undefined;
    }
    return {
      root,
      manifestPath,
      relatedPaths: { lock: join(root, 'package-lock.json') },
    };
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = JSON.parse(
      await readFile(project.manifestPath, 'utf8'),
    ) as PackageJson;
    const out: NativeRequirement[] = [];
    for (const field of DEPENDENCY_FIELDS) {
      const scope = scopeOfField(field);
      for (const [name, range] of Object.entries(parsed[field] ?? {})) {
        out.push({
          purl: purlForName(name),
          name,
          ...(typeof range === 'string' && range !== '' && { range }),
          scope,
        });
      }
    }
    return out;
  }

  async writeManifest(
    project: DetectedProject,
    requirements: readonly NativeRequirement[],
    options: WriteManifestOptions = {},
  ): Promise<ProjectionResult> {
    const semanticLoss: SemanticLoss[] = [];
    const retire = new Set(options.retire ?? []);
    const managed = new Map<string, { field: string; range: string }>();

    for (const requirement of requirements) {
      const field = SCOPE_FIELD[requirement.scope];
      if (field === undefined) {
        semanticLoss.push(scopeLoss(requirement));
        continue;
      }
      managed.set(requirement.name, {
        field,
        // npm accepts `*` for "any version". Writing an empty string produces
        // a manifest npm rejects, so absence becomes the range npm spells.
        range: requirement.range ?? '*',
      });
    }

    const { changed } = await editJsonFile<PackageJson>(
      project.manifestPath,
      (manifest) => {
        // A dependency opm manages must appear once, in the field its scope
        // maps to. Leaving a stale copy in another field would let npm install
        // a version opm never chose.
        for (const field of DEPENDENCY_FIELDS) {
          const block = manifest[field];
          if (!block) continue;
          for (const name of Object.keys(block)) {
            const entry = managed.get(name);
            if (entry && entry.field !== field) delete block[name];
            // Retired names are ones opm wrote and no longer declares. Only
            // those: a dependency someone added by hand is theirs to keep.
            else if (!entry && retire.has(name)) delete block[name];
          }
          if (Object.keys(block).length === 0) delete manifest[field];
        }
        for (const [name, { field, range }] of managed) {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          const block = (manifest[field] ??= {}) as Record<string, string>;
          block[name] = range;
        }
        // Sort each managed field so two projects with the same requirements
        // produce the same file, which is what makes the write idempotent.
        for (const field of DEPENDENCY_FIELDS) {
          const block = manifest[field];
          if (!block) continue;
          manifest[field] = Object.fromEntries(
            Object.entries(block).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          );
        }
      },
    );

    return {
      written: changed ? [project.manifestPath] : [],
      semanticLoss,
    };
  }

  /**
   * Write `package-lock.json` (lockfileVersion 3).
   *
   * npm verifies `integrity` against the tarball it downloads, so an entry
   * whose SRI opm never captured is refused rather than written without one —
   * a lockfile npm rejects, or worse accepts without checking, is not an
   * improvement over having none.
   */
  async writeLockfile(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult> {
    const lockPath = project.relatedPaths?.lock;
    if (!lockPath) return { written: [], semanticLoss: [] };

    const semanticLoss: SemanticLoss[] = [];
    const entries: Record<string, unknown> = {};
    for (const entry of packages) {
      if (!entry.nativeIntegrity || entry.nativeIntegrity.encoding !== 'sri') {
        semanticLoss.push(integrityLoss(entry));
        continue;
      }
      entries[`node_modules/${entry.name}`] = {
        version: entry.version,
        resolved: entry.source,
        integrity: `${entry.nativeIntegrity.algorithm}-${entry.nativeIntegrity.value}`,
        ...(entry.scope === 'development' && { dev: true }),
      };
    }
    if (semanticLoss.length > 0)
      // Partial lockfiles are how a build silently installs something nobody
      // pinned. All or nothing.
      return {
        written: [],
        skipped: [
          {
            path: lockPath,
            reason: 'not every package carried an npm integrity value',
          },
        ],
        semanticLoss,
      };

    const name = await manifestName(project.manifestPath);
    const body = {
      name,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name,
          dependencies: Object.fromEntries(
            packages
              .filter(
                (entry) => !entry.transitive && entry.scope !== 'development',
              )
              .map((entry) => [entry.name, entry.range ?? entry.version]),
          ),
        },
        ...entries,
      },
    };
    await writeFileAtomic(lockPath, `${JSON.stringify(body, undefined, 2)}\n`);
    return { written: [lockPath], semanticLoss: [] };
  }

  /**
   * Materialise `node_modules/` from the opm store.
   *
   * A tree Node resolves to the version the solve selected for every
   * dependency edge: hoisted to the root where that is unambiguous, nested in
   * the dependent's own `node_modules` where two versions of one name are
   * needed (`layout-plan.ts`). Files are hard links to the store's, so a
   * package's bytes exist once on disk; executables are script shims, because
   * the layout never creates a symlink.
   *
   * This is emphatically not `npm install`. It states so in its loss rather
   * than letting a project believe npm's own steps ran.
   */
  async writeLayout(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult> {
    const outcome = await writeNodeModules(project.root, packages);
    return {
      written: outcome.packages > 0 ? [outcome.root] : [],
      ...(outcome.skipped.length > 0 && { skipped: outcome.skipped }),
      semanticLoss:
        outcome.packages > 0
          ? [layoutLoss(outcome, project.metadata?.layoutOnly === true)]
          : [],
    };
  }

  /**
   * `node_modules` does not need a `package.json` beside it, so a plain opm
   * project can have one. Only the layout is written there: opm does not
   * create a manifest the person never asked for.
   */
  async detectLayout(root: string): Promise<DetectedProject | undefined> {
    return {
      root,
      manifestPath: join(root, 'package.json'),
      relatedPaths: { lock: join(root, 'package-lock.json') },
      metadata: { layoutOnly: true },
    };
  }

  /**
   * Build the `.tgz` npm publishes.
   *
   * npm's `files`/`.npmignore` rules decide what ships. They are honoured here
   * for the parts that are data — the `files` allowlist and npm's always-
   * include and always-exclude sets — and a project relying on `.npmignore`
   * gets that read too. What is not attempted is npm's full precedence
   * behaviour; where this differs it says so rather than quietly shipping a
   * different set of files.
   */
  async pack(
    project: DetectedProject,
    options: PackProjectOptions = {},
  ): Promise<PackedArtifact> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const manifest = JSON.parse(
      await readFile(project.manifestPath, 'utf8'),
    ) as PackageJson;
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

function scopeOfField(
  field: (typeof DEPENDENCY_FIELDS)[number],
): RequirementScope {
  switch (field) {
    case 'devDependencies':
      return 'development';
    case 'optionalDependencies':
      return 'optional';
    case 'peerDependencies':
      return 'peer';
    default:
      return 'runtime';
  }
}

/** `@scope/name` → `pkg:npm/%40scope/name`, per the PURL npm rules. */
function purlForName(name: string): string {
  if (!name.startsWith('@')) return `pkg:npm/${encodeURIComponent(name)}`;
  const slash = name.indexOf('/');
  if (slash === -1) return `pkg:npm/${encodeURIComponent(name)}`;
  return `pkg:npm/%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(
    name.slice(slash + 1),
  )}`;
}

function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'npm',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to package.json',
    omittedMeaning: `npm has no dependency field for the "${requirement.scope}" scope`,
    mitigation:
      'Declare the package with a scope npm expresses: runtime, development, optional, or peer.',
    blocksProfile: ['native-validated-v1'],
  };
}

async function manifestName(manifestPath: string): Promise<string> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: string;
  };
  return parsed.name ?? 'project';
}

function integrityLoss(entry: NativeLockEntry): SemanticLoss {
  return {
    code: 'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
    severity: 'warning',
    sourceEcosystem: 'npm',
    sourcePath: `/packages/${entry.name}`,
    originalMeaning: `${entry.name}@${entry.version} was resolved and pinned by digest`,
    representedMeaning: 'No package-lock.json was written',
    omittedMeaning:
      'npm pins with Subresource Integrity over the tarball, which was not captured for this package',
    mitigation:
      'Re-resolve so the integrity value is captured, or keep native_projection at "manifest".',
    blocksProfile: ['native-validated-v1'],
  };
}

function layoutLoss(outcome: LayoutOutcome, layoutOnly: boolean): SemanticLoss {
  const nested =
    outcome.nested > 0
      ? `, ${outcome.nested} nested to keep conflicting versions apart`
      : '';
  return {
    code: 'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'npm',
    sourcePath: outcome.root,
    originalMeaning:
      'node_modules was materialised from the digest-verified opm store',
    representedMeaning: `${outcome.packages} package(s) in a node_modules Node can resolve${nested}, ${
      outcome.copied ? 'copied' : 'hardlinked'
    } from the store, with ${outcome.bins} executable(s) as script shims in .bin${
      layoutOnly ? '; there is no package.json here and none was created' : ''
    }`,
    omittedMeaning:
      'npm was not run: no lifecycle scripts, no symlinked bin links, and a placement that is correct for the selected versions but not necessarily the one npm would choose',
    mitigation:
      'Run npm install if a package needs its install scripts, or keep native_projection at "lock".',
    blocksProfile: [],
  };
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
  ) as PackageJson;
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

function packLoss(): SemanticLoss {
  return {
    code: 'NATIVE_PACK_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'npm',
    sourcePath: '/pack',
    originalMeaning: 'A publishable npm tarball was built from the project',
    representedMeaning:
      'A deterministic gzipped tar with the package/ prefix, honouring files, .npmignore and npm always-include rules',
    omittedMeaning:
      'npm pack was not run: prepack and prepare scripts did not execute, and npm ignore precedence is approximated rather than reimplemented',
    mitigation:
      'Run npm pack when a package depends on its prepack scripts to produce publishable output.',
    blocksProfile: [],
  };
}
