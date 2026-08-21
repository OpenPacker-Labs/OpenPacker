/**
 * `Cargo.toml` as a PREX project format.
 *
 * Cargo reads `[dependencies]`, `[dev-dependencies]` and `[build-dependencies]`
 * — three tables rather than one field with a marker, which is why scope maps
 * onto a table name here rather than onto a key.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
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
import { editTomlTable, writeFileAtomic } from '@openpacker/project-io';

const SCOPE_TABLE = {
  runtime: 'dependencies',
  development: 'dev-dependencies',
  build: 'build-dependencies',
  // Cargo has neither; optional dependencies are a key on the entry, and peer
  // dependencies do not exist at all.
  optional: undefined,
  peer: undefined,
};

const TABLES = [
  'dependencies',
  'dev-dependencies',
  'build-dependencies',
] as const;

export class CargoProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.cargo';
  readonly purlType = 'cargo' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const manifestPath = join(root, 'Cargo.toml');
    try {
      await access(manifestPath);
    } catch {
      return undefined;
    }
    return {
      root,
      manifestPath,
      relatedPaths: { lock: join(root, 'Cargo.lock') },
    };
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = parse(
      await readFile(project.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const out: NativeRequirement[] = [];
    for (const table of TABLES) {
      const block = parsed[table];
      if (!block || typeof block !== 'object') continue;
      for (const [name, value] of Object.entries(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        block as Record<string, unknown>,
      )) {
        // A dependency is either a version string or a table with a `version`.
        const range =
          typeof value === 'string'
            ? value
            : typeof value === 'object' &&
                value !== null &&
                // SAFETY: The surrounding boundary establishes the asserted domain contract.
                typeof (value as { version?: unknown }).version === 'string'
              ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
                (value as { version: string }).version
              : undefined;
        out.push({
          purl: `pkg:cargo/${encodeURIComponent(name)}`,
          name,
          ...(!(range === undefined) && { range }),
          scope: scopeOfTable(table),
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
    const byTable = new Map<string, { key: string; value: string }[]>();
    const managed = new Set<string>();

    for (const requirement of requirements) {
      const table = SCOPE_TABLE[requirement.scope];
      if (table === undefined) {
        semanticLoss.push(scopeLoss(requirement));
        continue;
      }
      managed.add(requirement.name);
      const entries = byTable.get(table) ?? [];
      entries.push({
        key: requirement.name,
        value: JSON.stringify(requirement.range ?? '*'),
      });
      byTable.set(table, entries);
    }

    const retire = new Set(options.retire ?? []);
    const written: string[] = [];
    for (const table of TABLES) {
      // A requirement that moved scope has to leave the table it was in, so
      // every table retires the names that do not belong to it.
      const entries = byTable.get(table) ?? [];
      const owned = new Set(entries.map((entry) => entry.key));
      const drop = [
        ...retire,
        ...[...managed].filter((name) => !owned.has(name)),
      ];
      const { changed } = await editTomlTable(project.manifestPath, {
        table,
        entries,
        retire: drop,
      });
      if (changed && !written.includes(project.manifestPath))
        written.push(project.manifestPath);
    }

    return { written, semanticLoss };
  }

  /**
   * Write `Cargo.lock`.
   *
   * Cargo's `checksum` is the sha256 hex of the .crate, which is the same
   * algorithm PREX pins with — so unlike npm and NuGet this can usually be
   * written, and an entry missing it is still refused rather than guessed.
   */
  async writeLockfile(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult> {
    const lockPath = project.relatedPaths?.lock;
    if (!lockPath) return { written: [], semanticLoss: [] };

    const semanticLoss: SemanticLoss[] = [];
    const blocks: string[] = [];
    for (const entry of packages) {
      if (!entry.nativeIntegrity || entry.nativeIntegrity.encoding !== 'hex') {
        semanticLoss.push(integrityLoss(entry));
        continue;
      }
      blocks.push(
        [
          '[[package]]',
          `name = ${JSON.stringify(entry.name)}`,
          `version = ${JSON.stringify(entry.version)}`,
          'source = "registry+https://github.com/rust-lang/crates.io-index"',
          `checksum = ${JSON.stringify(entry.nativeIntegrity.value)}`,
        ].join('\n'),
      );
    }
    if (semanticLoss.length > 0)
      return {
        written: [],
        skipped: [
          {
            path: lockPath,
            reason: 'not every package carried a Cargo checksum',
          },
        ],
        semanticLoss,
      };

    const body = [
      '# This file is maintained by opm. Do not edit by hand.',
      'version = 3',
      '',
      ...blocks.map((block) => `${block}\n`),
    ].join('\n');
    await writeFileAtomic(lockPath, body);
    return { written: [lockPath], semanticLoss: [] };
  }
}

function scopeOfTable(table: (typeof TABLES)[number]): RequirementScope {
  return table === 'dev-dependencies'
    ? 'development'
    : table === 'build-dependencies'
      ? 'build'
      : 'runtime';
}

function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'cargo',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to Cargo.toml',
    omittedMeaning: `Cargo has no dependency table for the "${requirement.scope}" scope`,
    mitigation:
      'Declare the package as runtime, development, or build, which map to Cargo dependency tables.',
    blocksProfile: ['native-validated-v1'],
  };
}

function integrityLoss(entry: NativeLockEntry): SemanticLoss {
  return {
    code: 'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
    severity: 'warning',
    sourceEcosystem: 'cargo',
    sourcePath: `/packages/${entry.name}`,
    originalMeaning: `${entry.name} ${entry.version} was resolved and pinned by digest`,
    representedMeaning: 'No Cargo.lock was written',
    omittedMeaning:
      'Cargo pins with a sha256 checksum over the .crate, which was not captured for this package',
    mitigation:
      'Re-resolve so the checksum is captured, or keep native_projection at "manifest".',
    blocksProfile: ['native-validated-v1'],
  };
}
