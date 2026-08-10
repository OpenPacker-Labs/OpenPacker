/**
 * `package.json` as a PREX project format.
 *
 * Everything else in a Node project — the IDE, `node`, CI, every other tool —
 * reads `package.json`. If `opm add` does not put the dependency there, opm and
 * the rest of the toolchain disagree about what the project needs.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DetectedProject,
  NativeLockEntry,
  NativeRequirement,
  ProjectFormat,
  ProjectionResult,
  RequirementScope,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import {
  editJsonFile,
  materialiseTree,
  writeFileAtomic,
} from '@openpacker/project-io';

/** Where each scope lives in package.json. */
const SCOPE_FIELD: Readonly<Record<RequirementScope, string | undefined>> = {
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
    const { readFile } = await import('node:fs/promises');
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
          ...(typeof range === 'string' && range !== '' ? { range } : {}),
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
        ...(entry.transitive ? {} : {}),
        ...(entry.scope === 'development' ? { dev: true } : {}),
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
   * A flat layout — every package at `node_modules/<name>` — which is what
   * Node's resolution algorithm reads and what npm itself produces when there
   * are no version conflicts. opm's lock holds one version per package, so a
   * flat layout is exactly representable; there is no nesting to invent.
   *
   * This is emphatically not `npm install`. It states so in its loss rather
   * than letting a project believe npm's own steps ran.
   */
  async writeLayout(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult> {
    const root = join(project.root, 'node_modules');
    const written: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let copied = false;

    for (const entry of packages) {
      if (!entry.storePath) {
        skipped.push({
          path: join(root, entry.name),
          reason: 'the package is not materialised in the opm store',
        });
        continue;
      }
      // npm tarballs wrap their contents in a `package/` directory, which the
      // opm store preserves; node_modules wants what is inside it.
      const source = (await pathExists(join(entry.storePath, 'package')))
        ? join(entry.storePath, 'package')
        : entry.storePath;
      const destination = join(root, ...entry.name.split('/'));
      const result = await materialiseTree(source, destination, root);
      copied ||= result.copied;
      written.push(destination);
    }

    return {
      written,
      ...(skipped.length > 0 ? { skipped } : {}),
      semanticLoss: written.length > 0 ? [layoutLoss(root, copied)] : [],
    };
  }
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
  const { readFile } = await import('node:fs/promises');
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function layoutLoss(root: string, copied: boolean): SemanticLoss {
  return {
    code: 'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'npm',
    sourcePath: root,
    originalMeaning:
      'node_modules was materialised from the digest-verified opm store',
    representedMeaning: `A flat node_modules Node can resolve, ${
      copied ? 'copied' : 'hardlinked'
    } from the store`,
    omittedMeaning:
      'npm was not run: no lifecycle scripts, no bin links npm would have made, and no npm-specific hoisting',
    mitigation:
      'Run npm install if a package needs its install scripts, or keep native_projection at "lock".',
    blocksProfile: [],
  };
}
