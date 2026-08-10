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
  NativeRequirement,
  ProjectFormat,
  ProjectionResult,
  RequirementScope,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import { editTomlTable } from '@openpacker/project-io';

const SCOPE_TABLE: Readonly<Record<RequirementScope, string | undefined>> = {
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
    const parsed = parse(
      await readFile(project.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const out: NativeRequirement[] = [];
    for (const table of TABLES) {
      const block = parsed[table];
      if (!block || typeof block !== 'object') continue;
      for (const [name, value] of Object.entries(
        block as Record<string, unknown>,
      )) {
        // A dependency is either a version string or a table with a `version`.
        const range =
          typeof value === 'string'
            ? value
            : typeof value === 'object' &&
                value !== null &&
                typeof (value as { version?: unknown }).version === 'string'
              ? (value as { version: string }).version
              : undefined;
        out.push({
          purl: `pkg:cargo/${encodeURIComponent(name)}`,
          name,
          ...(range === undefined ? {} : { range }),
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
