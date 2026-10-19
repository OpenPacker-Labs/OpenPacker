/**
 * `package.json` as a PREX project format.
 *
 * Everything else in a Node project — the IDE, `node`, CI, every other tool —
 * reads `package.json`. If `opm add` does not put the dependency there, opm and
 * the rest of the toolchain disagree about what the project needs.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DetectedProject,
  FrozenLock,
  FrozenLockOptions,
  NativeLayoutWorkspace,
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
import { editJsonFile, writeFileAtomic } from '@openpacker/project-io';
import { formatNpmAlias, isNpmAlias, parseNpmAlias } from './alias.js';
import { readFrozenPackageLock } from './frozen-lock.js';
import { layoutLoss } from './layout-loss.js';
import { planLayout, toLayoutEntries } from './layout-plan.js';
import { writeNodeModules } from './layout-write.js';
import { integrityLoss, scopeLoss } from './project-losses.js';
import { packNpmProject } from './project-pack.js';
import { purlForName } from './purl.js';

export { npmPublishPaths } from './project-pack.js';

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
  /** `package.json` `workspaces` is npm's: a frozen install reads members the way npm does. */
  readonly workspaceTool = 'npm' as const;

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
        // `"string-width-cjs": "npm:string-width@^4.2.0"` asks for string-width,
        // installed as string-width-cjs; reading it as the registry's package of
        // the key's name would be a different package.
        const alias =
          typeof range === 'string' && isNpmAlias(range)
            ? parseNpmAlias(range)
            : undefined;
        if (alias !== undefined && 'target' in alias) {
          out.push({
            purl: purlForName(alias.target),
            name: alias.target,
            installName: name,
            ...(alias.spec !== '*' && { range: alias.spec }),
            scope,
          });
          continue;
        }
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
      managed.set(requirement.installName ?? requirement.name, {
        field,
        // npm accepts `*` for "any version". Writing an empty string produces
        // a manifest npm rejects, so absence becomes the range npm spells. An
        // alias is written as npm writes one: the key is the install name.
        range:
          requirement.installName === undefined
            ? (requirement.range ?? '*')
            : formatNpmAlias(requirement.name, requirement.range),
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
    for (const entry of packages)
      if (!entry.nativeIntegrity || entry.nativeIntegrity.encoding !== 'sri')
        semanticLoss.push(integrityLoss(entry));
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
    // Where Node would find each package: a name selected at two versions, or
    // installed under an alias, is not at `node_modules/<name>`.
    const plan = planLayout(toLayoutEntries(packages));
    if (plan.skipped.length > 0)
      return {
        written: [],
        skipped: [
          {
            path: lockPath,
            reason: `the closure cannot be laid out as npm would: ${plan.skipped
              .slice(0, 3)
              .map((item) => item.reason)
              .join('; ')}`,
          },
        ],
        semanticLoss: [],
      };
    for (const { entry, chain } of plan.placements) {
      const source = entry.source;
      const integrity = source.nativeIntegrity!;
      entries[`node_modules/${chain.join('/node_modules/')}`] = {
        // A package installed under another name says what it is.
        ...(chain.at(-1) !== entry.name && { name: entry.name }),
        version: entry.version,
        resolved: source.source,
        integrity: `${integrity.algorithm}-${integrity.value}`,
        ...(source.scope === 'development' && { dev: true }),
      };
    }

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
              .map((entry) => [
                entry.installName ?? entry.name,
                entry.installName === undefined
                  ? (entry.range ?? entry.version)
                  : formatNpmAlias(entry.name, entry.range ?? entry.version),
              ]),
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
    options: { workspace?: NativeLayoutWorkspace } = {},
  ): Promise<ProjectionResult> {
    const outcome = await writeNodeModules(project.root, packages, {
      links: options.workspace?.links ?? [],
      members: options.workspace?.members ?? [],
    });
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
   * `package-lock.json` as `npm ci` reads it: what this machine installs, what
   * it leaves out, and what the lock holds that cannot be installed.
   */
  readFrozenLock(
    project: DetectedProject,
    options: FrozenLockOptions,
  ): Promise<FrozenLock> {
    return readFrozenPackageLock(project, options);
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
    return packNpmProject(project, options);
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

async function manifestName(manifestPath: string): Promise<string> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: string;
  };
  return parsed.name ?? 'project';
}
