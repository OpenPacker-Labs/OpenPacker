/**
 * `pyproject.toml` as a PREX project format.
 *
 * PEP 621 keeps dependencies as an array of PEP 508 requirement strings under
 * `[project]`, not as a table of names — so a projection here rewrites the
 * array, carrying across every entry it does not own. That is also why
 * ownership is decided by parsing each string's name rather than by a key.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type {
  DetectedProject,
  NativeRequirement,
  ProjectFormat,
  ProjectionResult,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import { editTomlArray, editTomlTable } from '@openpacker/project-io';

/** PEP 508: a name, then optional extras, then the version specifier. */
const REQUIREMENT = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/u;

export class PypiProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.pypi';
  readonly purlType = 'pypi' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const manifestPath = join(root, 'pyproject.toml');
    try {
      await access(manifestPath);
    } catch {
      return undefined;
    }
    return {
      root,
      manifestPath,
      relatedPaths: { lock: join(root, 'uv.lock') },
    };
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = parse(await readFile(project.manifestPath, 'utf8')) as {
      project?: {
        dependencies?: unknown;
        'optional-dependencies'?: Record<string, unknown>;
      };
      'dependency-groups'?: Record<string, unknown>;
    };
    const out: NativeRequirement[] = [];
    for (const item of asStrings(parsed.project?.dependencies))
      out.push(requirementOf(item, 'runtime'));
    for (const group of Object.values(
      parsed.project?.['optional-dependencies'] ?? {},
    ))
      for (const item of asStrings(group))
        out.push(requirementOf(item, 'optional'));
    // PEP 735 dependency groups are where dev tooling lives in modern
    // pyproject files, and uv writes them there by default.
    for (const group of Object.values(parsed['dependency-groups'] ?? {}))
      for (const item of asStrings(group))
        out.push(requirementOf(item, 'development'));
    return out;
  }

  async writeManifest(
    project: DetectedProject,
    requirements: readonly NativeRequirement[],
    options: WriteManifestOptions = {},
  ): Promise<ProjectionResult> {
    const semanticLoss: SemanticLoss[] = [];
    const runtime: string[] = [];
    const development: string[] = [];

    for (const requirement of requirements) {
      if (requirement.scope === 'peer' || requirement.scope === 'build') {
        semanticLoss.push(scopeLoss(requirement));
        continue;
      }
      const rendered = `${requirement.name}${requirement.range ?? ''}`;
      if (requirement.scope === 'development') development.push(rendered);
      else runtime.push(rendered);
    }

    // Ownership is by distribution name: opm rewrites its own entries and
    // leaves anything else the file declares exactly where it is.
    const owned = new Set([
      ...requirements.map((requirement) => normalize(requirement.name)),
      ...(options.retire ?? []).map((name) => normalize(name)),
    ]);
    const owns = (item: string) => owned.has(normalize(nameOf(item)));

    const written: string[] = [];
    const runtimeResult = await editTomlArray(project.manifestPath, {
      table: 'project',
      key: 'dependencies',
      items: runtime,
      owns,
    });
    if (runtimeResult.changed) written.push(project.manifestPath);

    if (development.length > 0 || (options.retire ?? []).length > 0) {
      const groupResult = await editTomlTable(project.manifestPath, {
        table: 'dependency-groups',
        entries:
          development.length > 0
            ? [
                {
                  key: 'dev',
                  value: `[${development.map((item) => JSON.stringify(item)).join(', ')}]`,
                },
              ]
            : [],
      });
      if (groupResult.changed && !written.includes(project.manifestPath))
        written.push(project.manifestPath);
    }

    return { written, semanticLoss };
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requirementOf(
  item: string,
  scope: NativeRequirement['scope'],
): NativeRequirement {
  const name = nameOf(item);
  const specifier = REQUIREMENT.exec(item)?.[3]?.trim() ?? '';
  return {
    purl: `pkg:pypi/${encodeURIComponent(normalize(name))}`,
    name,
    ...(!(specifier === '') && { range: specifier }),
    scope,
  };
}

function nameOf(item: string): string {
  return REQUIREMENT.exec(item)?.[1] ?? item.trim();
}

/** PEP 503 normalisation: `Foo.Bar_baz` and `foo-bar-baz` are one project. */
function normalize(name: string): string {
  return name.replace(/[-_.]+/gu, '-').toLowerCase();
}

function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'pypi',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to pyproject.toml',
    omittedMeaning: `PEP 621 has no dependency list for the "${requirement.scope}" scope`,
    mitigation:
      'Declare the package as runtime, development, or optional, which map to project.dependencies, dependency-groups.dev, and project.optional-dependencies.',
    blocksProfile: ['native-validated-v1'],
  };
}
