/**
 * Project opm's decisions into the project files each ecosystem's own tooling
 * reads.
 *
 * `opm.toml` is authoritative — this never reads a native manifest to decide
 * anything. It carries a decision that was already made into `package.json`,
 * a `.csproj`, `pyproject.toml`, so that opm and the native toolchain agree
 * about what the project needs.
 *
 * Nothing here is best-effort in the sense of "silently half-works": an
 * adapter that does not advertise a level does not get that level, a format
 * that cannot express something records `SemanticLoss`, and a failure to write
 * is reported rather than swallowed.
 */

import type {
  NativeLockEntry,
  NativeRequirement,
  PackedArtifact,
  PackOutcome,
  ProjectFormat,
  ProjectionResult,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@openpacker/project-io';
import { hasResource } from '@openpacker/adapter-host';
import { requireAdapterRegistry } from './adapters.js';
import { OPM_DIR, storePathForDigest } from './paths.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import type {
  LockPackage,
  NativeProjectionLevel,
  OpmLockfile,
  OpmManifest,
} from './types.js';
import { OpmError } from './types.js';

export interface NativeProjectionReport {
  /** One entry per ecosystem that had a project to write. */
  projections: readonly {
    ecosystem: string;
    manifestPath: string;
    written: readonly string[];
    skipped?: readonly { path: string; reason: string }[];
    semanticLoss: readonly SemanticLoss[];
  }[];
  /** Ecosystems whose adapter offers no project format, or that detected none. */
  unprojected: readonly { ecosystem: string; reason: string }[];
}

/** Where the record of what opm has written to native files lives. */
export const NATIVE_STATE = 'native.json';

/**
 * Names opm has written into each ecosystem's project file.
 *
 * Kept because a projection cannot treat the requirement set as an allowlist:
 * a project may hold dependencies someone added by hand, and deleting those
 * because opm.toml does not mention them would destroy work opm never owned.
 * Removal is therefore limited to names opm itself wrote.
 */
export interface NativeProjectionState {
  nativeStateVersion: '1';
  managed: Record<string, string[]>;
}

export async function readNativeState(
  root: string,
): Promise<NativeProjectionState> {
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = JSON.parse(
      await readFile(join(root, OPM_DIR, NATIVE_STATE), 'utf8'),
    ) as NativeProjectionState;
    if (parsed.nativeStateVersion !== '1' || typeof parsed.managed !== 'object')
      return { nativeStateVersion: '1', managed: {} };
    return parsed;
  } catch {
    return { nativeStateVersion: '1', managed: {} };
  }
}

export async function writeNativeState(
  root: string,
  state: NativeProjectionState,
): Promise<void> {
  await writeFileAtomic(
    join(root, OPM_DIR, NATIVE_STATE),
    `${JSON.stringify(state, undefined, 2)}\n`,
  );
}

const LEVEL_RANK = {
  off: 0,
  manifest: 1,
  lock: 2,
  layout: 3,
};

/** The level a manifest asks for, defaulting to writing the native manifest. */
export function projectionLevel(manifest: OpmManifest): NativeProjectionLevel {
  return manifest.options.nativeProjection ?? 'manifest';
}

/**
 * Write every native project file this project has.
 *
 * Called after the lock and the store are already updated, so a failed resolve
 * never reaches a native file, and what lands there is what opm actually
 * decided.
 */
export async function projectNativeFormats(input: {
  root: string;
  manifest: OpmManifest;
  lock: OpmLockfile;
  level?: NativeProjectionLevel;
}) {
  const level = input.level ?? projectionLevel(input.manifest);
  const projections: NativeProjectionReport['projections'][number][] = [];
  const unprojected: { ecosystem: string; reason: string }[] = [];
  if (level === 'off') return { projections, unprojected };

  const registry = requireAdapterRegistry();
  const previous = await readNativeState(input.root);
  const managed: Record<string, string[]> = { ...previous.managed };
  let stateChanged = false;

  // Previously-managed ecosystems are visited even when nothing references
  // them any more: removing the last npm package is exactly when package.json
  // needs the entry taken out, and by then neither the manifest nor the lock
  // mentions npm at all.
  for (const ecosystem of ecosystemsOf(
    input.manifest,
    input.lock,
    Object.keys(previous.managed),
  )) {
    let format: ProjectFormat | undefined;
    try {
      format = await registry.projectFormatFor(ecosystem);
    } catch (error) {
      unprojected.push({
        ecosystem,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!format) {
      unprojected.push({
        ecosystem,
        reason: `the ${ecosystem} adapter does not advertise prex.registry.project-manifest/1`,
      });
      continue;
    }

    const detected = await format.detect(input.root);
    if (!detected) {
      unprojected.push({
        ecosystem,
        reason: `no ${ecosystem} project file in ${input.root}`,
      });
      continue;
    }

    const levels = await registry.projectionLevels(ecosystem);
    const written: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const semanticLoss: SemanticLoss[] = [];

    const requirements = requirementsFor(ecosystem, input.manifest, input.lock);
    const names = requirements.map((requirement) => requirement.name).sort();
    const retire = (previous.managed[ecosystem] ?? []).filter(
      (name) => !names.includes(name),
    );
    const manifestResult = await format.writeManifest(detected, requirements, {
      retire,
    });
    collect(manifestResult, written, skipped, semanticLoss);
    managed[ecosystem] = names;
    stateChanged = true;

    if (LEVEL_RANK[level] >= LEVEL_RANK.lock && format.writeLockfile) {
      if (!levels.lock)
        skipped.push({
          path: detected.manifestPath,
          reason: `the ${ecosystem} adapter does not advertise prex.registry.project-lock/1`,
        });
      else
        collect(
          await format.writeLockfile(
            detected,
            lockEntriesFor(ecosystem, input.manifest, input.lock, input.root),
          ),
          written,
          skipped,
          semanticLoss,
        );
    }

    if (LEVEL_RANK[level] >= LEVEL_RANK.layout && format.writeLayout) {
      if (!levels.layout)
        skipped.push({
          path: detected.manifestPath,
          reason: `the ${ecosystem} adapter does not advertise prex.registry.project-layout/1`,
        });
      else
        collect(
          await format.writeLayout(
            detected,
            lockEntriesFor(ecosystem, input.manifest, input.lock, input.root),
          ),
          written,
          skipped,
          semanticLoss,
        );
    }

    projections.push({
      ecosystem,
      manifestPath: detected.manifestPath,
      written,
      ...(skipped.length > 0 && { skipped }),
      semanticLoss,
    });
  }

  if (stateChanged)
    await writeNativeState(input.root, {
      nativeStateVersion: '1',
      managed,
    });

  return { projections, unprojected };
}

/**
 * Build the vendor archive for one ecosystem in this project.
 *
 * Separate from projectNativeFormats because packing is something a user asks
 * for, not something that happens because a dependency changed.
 */
export async function packNativeProject(input: {
  root: string;
  ecosystem: string;
  outputDirectory?: string;
}): Promise<PackedArtifact> {
  const registry = requireAdapterRegistry();
  const definition = await registry.definitionFor(input.ecosystem);
  if (!hasResource(definition, 'prex.registry.package-build/1'))
    throw new OpmError(
      'UNSUPPORTED_OPERATION',
      `The ${input.ecosystem} adapter does not advertise prex.registry.package-build/1, ` +
        'so it cannot build a package for this project.',
    );
  const format = await registry.projectFormatFor(input.ecosystem);
  if (!format?.pack)
    throw new OpmError(
      'UNSUPPORTED_OPERATION',
      `The ${input.ecosystem} adapter has no project packer.`,
    );
  const detected = await format.detect(input.root);
  if (!detected)
    throw new OpmError(
      'NOT_FOUND',
      `No ${input.ecosystem} project file in ${input.root}.`,
    );
  return format.pack(detected, {
    ...(!(input.outputDirectory === undefined) && {
      outputDirectory: input.outputDirectory,
    }),
  });
}

/** Plan or run the versioned, typed native pack capability. */
export async function packDelegatedProject(input: {
  root: string;
  ecosystem: string;
  provider?: string;
  name: string;
  version: string;
  outputDirectory?: string;
  authorizedEnvironment?: Readonly<Record<string, string>>;
  allowBuild?: boolean;
  allowNetwork?: boolean;
  offline?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<PackOutcome> {
  const registry = requireAdapterRegistry();
  const packer = registry.delegatedPackerFor(input.ecosystem, input.provider);
  const detected = await packer.detect(input.root);
  if (!detected)
    throw new OpmError(
      'NOT_FOUND',
      `No ${input.ecosystem} packable project in ${input.root}.`,
    );
  return packer.pack(
    {
      project: detected,
      target: {
        purlType: input.ecosystem,
        identifier: input.name,
        version: input.version,
      },
    },
    {
      strategy: 'delegate',
      ...(!(input.outputDirectory === undefined) && {
        outputDirectory: input.outputDirectory,
      }),
      ...(!(input.authorizedEnvironment === undefined) && {
        authorizedEnvironment: input.authorizedEnvironment,
      }),
      ...(!(input.allowBuild === undefined) && {
        allowBuild: input.allowBuild,
      }),
      ...(!(input.allowNetwork === undefined) && {
        allowNetwork: input.allowNetwork,
      }),
      ...(!(input.offline === undefined) && { offline: input.offline }),
      ...(!(input.dryRun === undefined) && { dryRun: input.dryRun }),
      ...(!(input.signal === undefined) && { signal: input.signal }),
    },
  );
}

function collect(
  result: ProjectionResult,
  written: string[],
  skipped: { path: string; reason: string }[],
  semanticLoss: SemanticLoss[],
): void {
  written.push(...result.written);
  if (result.skipped) skipped.push(...result.skipped);
  semanticLoss.push(...result.semanticLoss);
}

/** Ecosystems this project actually uses, from the manifest and the lock. */
function ecosystemsOf(
  manifest: OpmManifest,
  lock: OpmLockfile,
  previouslyManaged: readonly string[] = [],
): readonly string[] {
  const out = new Set<string>(previouslyManaged);
  for (const requirement of Object.values(manifest.packages)) {
    try {
      out.add(ecosystemFromPurl(requirement.purl));
    } catch {
      // A requirement whose purl cannot be read has bigger problems than its
      // projection, and resolve will have said so.
    }
  }
  for (const pkg of Object.values(lock.packages)) out.add(pkg.ecosystem);
  return [...out].sort();
}

/**
 * The direct requirements for one ecosystem, in that ecosystem's own spelling.
 *
 * Only direct requirements: a native manifest declares what the project asks
 * for, and writing the whole closure there would turn every transitive
 * dependency into a top-level declaration the project never made.
 */
function requirementsFor(
  ecosystem: string,
  manifest: OpmManifest,
  lock: OpmLockfile,
): readonly NativeRequirement[] {
  const out: NativeRequirement[] = [];
  for (const [alias, requirement] of Object.entries(manifest.packages)) {
    let purlType: string;
    try {
      purlType = ecosystemFromPurl(requirement.purl);
    } catch {
      continue;
    }
    if (purlType !== ecosystem) continue;
    // A requirement pinned by an explicit source has no native coordinate to
    // write; the native tool would have to fetch it the same way, and it
    // cannot.
    if (requirement.source !== undefined) continue;

    const locked = lock.packages[alias];
    const base = stripPurlVersion(requirement.purl);
    out.push({
      purl: base,
      name: nativeName(base),
      ...(!(rangeFor(requirement.version, locked) === undefined) && {
        range: rangeFor(requirement.version, locked)!,
      }),
      scope: requirement.scope ?? 'runtime',
    });
  }
  return out.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * What to write as the native range.
 *
 * The manifest's own version string when there is one — that is what the user
 * asked for, and rewriting `^4.1.2` as `4.1.2` would silently narrow the
 * project. Otherwise the version that was locked, so the native file is not
 * left saying "any".
 */
function rangeFor(
  declared: string | undefined,
  locked: LockPackage | undefined,
): string | undefined {
  if (declared !== undefined && declared !== '') return declared;
  return locked?.version;
}

function lockEntriesFor(
  ecosystem: string,
  manifest: OpmManifest,
  lock: OpmLockfile,
  root?: string,
): readonly NativeLockEntry[] {
  const direct = new Set(
    Object.values(manifest.packages)
      .map((requirement) => {
        try {
          return stripPurlVersion(requirement.purl);
        } catch {
          return undefined;
        }
      })
      .filter((purl): purl is string => purl !== undefined),
  );

  const out: NativeLockEntry[] = [];
  for (const pkg of Object.values(lock.packages)) {
    if (pkg.ecosystem !== ecosystem) continue;
    const base = stripPurlVersion(pkg.purl);
    out.push({
      purl: base,
      exactPurl: pkg.purl,
      name: nativeName(base),
      version: pkg.version,
      scope: scopeOf(manifest, pkg),
      source: pkg.source,
      digest: pkg.digest,
      size: pkg.size,
      ...(!(pkg.nativeIntegrity === undefined) && {
        nativeIntegrity: pkg.nativeIntegrity,
      }),
      // Where the extracted tree already is. A layout projection copies from
      // here rather than re-downloading, so what lands in node_modules is the
      // same digest-verified bytes the store holds.
      ...(!(root === undefined) && {
        storePath: storePathForDigest(root, pkg.digest),
      }),
      transitive: pkg.reason === 'transitive' || !direct.has(base),
    });
  }
  return out.sort((left, right) =>
    left.name === right.name
      ? left.version < right.version
        ? -1
        : 1
      : left.name < right.name
        ? -1
        : 1,
  );
}

function scopeOf(manifest: OpmManifest, pkg: LockPackage) {
  return manifest.packages[pkg.alias]?.scope ?? 'runtime';
}

/**
 * The name an ecosystem spells a package with, recovered from its PURL.
 *
 * PURL percent-encodes the parts that would otherwise be structural, so `@` in
 * an npm scope arrives as `%40`. Decoding per segment rather than over the
 * whole string keeps a literal `/` inside a segment from becoming a separator.
 */
export function nativeName(basePurl: string): string {
  const withoutScheme = basePurl.replace(/^pkg:[A-Za-z0-9.+-]+\//u, '');
  const withoutQualifiers = withoutScheme.split(/[?#]/u)[0] ?? withoutScheme;
  return withoutQualifiers
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}
