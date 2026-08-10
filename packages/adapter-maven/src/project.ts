/**
 * Maven and Gradle projects as a PREX project format.
 *
 * `pom.xml` is data and can be edited. A Gradle build script is a **program** —
 * `build.gradle.kts` is Kotlin, and a dependency can be added by a loop, a
 * function or a convention plugin. The writable surface for Gradle is the
 * version catalog (`gradle/libs.versions.toml`), which is data by design; a
 * project without one gets recorded loss rather than a mangled build script.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseToml } from 'smol-toml';
import type {
  DetectedProject,
  NativeRequirement,
  ProjectFormat,
  ProjectionResult,
  RequirementScope,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import {
  applySpanEdits,
  editTomlTable,
  matchFileStyle,
  ProjectIoError,
  readTextFile,
  writeFileAtomic,
  type SpanEdit,
} from '@openpacker/project-io';

const parser = new XMLParser({ ignoreAttributes: false });

/** Maven scopes, in the vocabulary Maven itself uses. */
const SCOPE_NAME: Readonly<Record<RequirementScope, string | undefined>> = {
  runtime: undefined, // `compile` is the default; writing it adds noise.
  development: 'test',
  optional: 'provided',
  build: 'provided',
  peer: undefined,
};

export class MavenProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.maven';
  readonly purlType = 'maven' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const pom = join(root, 'pom.xml');
    if (await exists(pom))
      return { root, manifestPath: pom, metadata: { kind: 'maven' } };

    const catalog = join(root, 'gradle', 'libs.versions.toml');
    if (await exists(catalog))
      return {
        root,
        manifestPath: catalog,
        metadata: { kind: 'gradle-catalog' },
      };

    for (const script of ['build.gradle.kts', 'build.gradle']) {
      if (await exists(join(root, script)))
        return {
          root,
          // Reported so the caller can name it in the loss; never written.
          manifestPath: join(root, script),
          metadata: { kind: 'gradle-script' },
        };
    }
    return undefined;
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    const kind = project.metadata?.kind;
    if (kind === 'maven')
      return readPom(await readFile(project.manifestPath, 'utf8'));
    if (kind === 'gradle-catalog')
      return readCatalog(await readFile(project.manifestPath, 'utf8'));
    return [];
  }

  async writeManifest(
    project: DetectedProject,
    requirements: readonly NativeRequirement[],
    options: WriteManifestOptions = {},
  ): Promise<ProjectionResult> {
    const kind = project.metadata?.kind;
    if (kind === 'gradle-script')
      return {
        written: [],
        skipped: [
          {
            path: project.manifestPath,
            reason: 'a Gradle build script is code, not a dependency list',
          },
        ],
        semanticLoss: [buildScriptLoss(project.manifestPath)],
      };

    if (kind === 'gradle-catalog')
      return writeCatalog(project, requirements, options);
    return writePom(project, requirements, options);
  }
}

// --- Maven -----------------------------------------------------------------

interface PomDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
  start: number;
  end: number;
}

const DEPENDENCY = /<dependency>[\s\S]*?<\/dependency>/gu;

function pomDependencies(text: string): PomDependency[] {
  const out: PomDependency[] = [];
  for (const match of text.matchAll(DEPENDENCY)) {
    const raw = match[0];
    const groupId = child(raw, 'groupId');
    const artifactId = child(raw, 'artifactId');
    if (!groupId || !artifactId) continue;
    const version = child(raw, 'version');
    const scope = child(raw, 'scope');
    out.push({
      groupId,
      artifactId,
      ...(version === undefined ? {} : { version }),
      ...(scope === undefined ? {} : { scope }),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return out;
}

function child(element: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'u').exec(
    element,
  )?.[1];
}

function readPom(text: string): NativeRequirement[] {
  return pomDependencies(text).map((dependency) => {
    const name = `${dependency.groupId}:${dependency.artifactId}`;
    return {
      purl: `pkg:maven/${encodeURIComponent(dependency.groupId)}/${encodeURIComponent(
        dependency.artifactId,
      )}`,
      name,
      ...(dependency.version === undefined
        ? {}
        : { range: dependency.version }),
      scope: dependency.scope === 'test' ? 'development' : ('runtime' as const),
    };
  });
}

async function writePom(
  project: DetectedProject,
  requirements: readonly NativeRequirement[],
  options: WriteManifestOptions,
): Promise<ProjectionResult> {
  const semanticLoss: SemanticLoss[] = [];
  const wanted = new Map<string, NativeRequirement>();
  for (const requirement of requirements) {
    if (requirement.scope === 'peer') {
      semanticLoss.push(scopeLoss('maven', requirement));
      continue;
    }
    if (!requirement.name.includes(':')) {
      semanticLoss.push(coordinateLoss(requirement));
      continue;
    }
    wanted.set(requirement.name, requirement);
  }
  const retire = new Set(options.retire ?? []);

  const file = await readTextFile(project.manifestPath);
  const edits: SpanEdit[] = [];
  const seen = new Set<string>();

  for (const dependency of pomDependencies(file.text)) {
    const name = `${dependency.groupId}:${dependency.artifactId}`;
    const requirement = wanted.get(name);
    if (!requirement) {
      if (retire.has(name))
        edits.push({
          start: lineStart(file.text, dependency.start),
          end: lineEnd(file.text, dependency.end),
          replacement: '',
        });
      continue;
    }
    seen.add(name);
    const raw = file.text.slice(dependency.start, dependency.end);
    const replacement = renderPomDependency(raw, requirement);
    if (replacement !== raw)
      edits.push({
        start: dependency.start,
        end: dependency.end,
        replacement,
      });
  }

  let text = applySpanEdits(file.text, edits);
  const additions = [...wanted.values()].filter(
    (requirement) => !seen.has(requirement.name),
  );
  if (additions.length > 0) text = insertPomDependencies(text, additions);

  const next = matchFileStyle(file, text);
  if (next === file.text) return { written: [], semanticLoss };
  assertXml(project.manifestPath, next);
  await writeFileAtomic(project.manifestPath, next);
  return { written: [project.manifestPath], semanticLoss };
}

function renderPomDependency(
  raw: string,
  requirement: NativeRequirement,
): string {
  const version = requirement.range;
  let next = raw;
  if (version !== undefined) {
    next = /<version>/u.test(next)
      ? next.replace(
          /<version>[\s\S]*?<\/version>/u,
          `<version>${escapeXml(version)}</version>`,
        )
      : next.replace(
          /(<\/artifactId>)/u,
          `$1\n      <version>${escapeXml(version)}</version>`,
        );
  }
  const scope = SCOPE_NAME[requirement.scope];
  if (scope !== undefined)
    next = /<scope>/u.test(next)
      ? next.replace(/<scope>[\s\S]*?<\/scope>/u, `<scope>${scope}</scope>`)
      : next.replace(
          /(<\/version>|<\/artifactId>)/u,
          `$1\n      <scope>${scope}</scope>`,
        );
  return next;
}

function insertPomDependencies(
  text: string,
  requirements: readonly NativeRequirement[],
): string {
  const rendered = requirements
    .map((requirement) => {
      const [groupId, artifactId] = requirement.name.split(':');
      const scope = SCOPE_NAME[requirement.scope];
      return [
        '    <dependency>',
        `      <groupId>${escapeXml(groupId!)}</groupId>`,
        `      <artifactId>${escapeXml(artifactId!)}</artifactId>`,
        ...(requirement.range === undefined
          ? []
          : [`      <version>${escapeXml(requirement.range)}</version>`]),
        ...(scope === undefined ? [] : [`      <scope>${scope}</scope>`]),
        '    </dependency>',
      ].join('\n');
    })
    .join('\n');

  const close = text.lastIndexOf('</dependencies>');
  if (close !== -1)
    return `${text.slice(0, close)}${rendered}\n  ${text.slice(close)}`;
  const projectClose = text.lastIndexOf('</project>');
  if (projectClose === -1)
    throw new ProjectIoError(
      'INVALID_PROJECT',
      'pom.xml',
      'pom.xml has no closing </project> element',
    );
  return `${text.slice(0, projectClose)}  <dependencies>\n${rendered}\n  </dependencies>\n${text.slice(projectClose)}`;
}

// --- Gradle version catalog ------------------------------------------------

function readCatalog(text: string): NativeRequirement[] {
  const parsed = parseToml(text) as {
    libraries?: Record<string, unknown>;
    versions?: Record<string, unknown>;
  };
  const versions = parsed.versions ?? {};
  const out: NativeRequirement[] = [];
  for (const value of Object.values(parsed.libraries ?? {})) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as {
      module?: string;
      group?: string;
      name?: string;
      version?: string | { ref?: string };
    };
    const name =
      entry.module ??
      (entry.group && entry.name ? `${entry.group}:${entry.name}` : undefined);
    if (!name) continue;
    const version =
      typeof entry.version === 'string'
        ? entry.version
        : typeof entry.version?.ref === 'string'
          ? String(versions[entry.version.ref] ?? '')
          : undefined;
    const [group, artifact] = name.split(':');
    out.push({
      purl: `pkg:maven/${encodeURIComponent(group ?? '')}/${encodeURIComponent(artifact ?? '')}`,
      name,
      ...(version ? { range: version } : {}),
      scope: 'runtime',
    });
  }
  return out;
}

async function writeCatalog(
  project: DetectedProject,
  requirements: readonly NativeRequirement[],
  options: WriteManifestOptions,
): Promise<ProjectionResult> {
  const semanticLoss: SemanticLoss[] = [];
  const entries: { key: string; value: string }[] = [];
  for (const requirement of requirements) {
    if (!requirement.name.includes(':')) {
      semanticLoss.push(coordinateLoss(requirement));
      continue;
    }
    entries.push({
      key: catalogAlias(requirement.name),
      value: `{ module = ${JSON.stringify(requirement.name)}, version = ${JSON.stringify(
        requirement.range ?? '+',
      )} }`,
    });
  }
  const { changed } = await editTomlTable(project.manifestPath, {
    table: 'libraries',
    entries,
    retire: (options.retire ?? [])
      .filter((name) => name.includes(':'))
      .map((name) => catalogAlias(name)),
  });
  // The catalog declares a library; adding it to a configuration is still the
  // build script's job, and opm does not write build scripts.
  if (changed) semanticLoss.push(catalogWiringLoss(project.manifestPath));
  return { written: changed ? [project.manifestPath] : [], semanticLoss };
}

/** Catalog aliases are dash-separated; Gradle exposes them as `libs.a.b`. */
function catalogAlias(name: string): string {
  return name.replace(/[:.]/gu, '-').replace(/[^A-Za-z0-9-]/gu, '-');
}

// --- shared ----------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function lineStart(text: string, offset: number): number {
  const previous = text.lastIndexOf('\n', offset - 1);
  return previous === -1 ? 0 : previous + 1;
}

function lineEnd(text: string, offset: number): number {
  const next = text.indexOf('\n', offset);
  return next === -1 ? text.length : next + 1;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function assertXml(path: string, text: string): void {
  try {
    parser.parse(text);
  } catch (error) {
    throw new ProjectIoError(
      'INVALID_XML',
      path,
      `Editing ${path} produced XML that does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function scopeLoss(
  ecosystem: string,
  requirement: NativeRequirement,
): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: ecosystem,
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to the project file',
    omittedMeaning: `Maven has no dependency scope equivalent to "${requirement.scope}"`,
    mitigation: 'Declare the package as runtime, development, or optional.',
    blocksProfile: ['native-validated-v1'],
  };
}

function coordinateLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_COORDINATE_INCOMPLETE',
    severity: 'error',
    sourceEcosystem: 'maven',
    sourcePath: `/packages/${requirement.name}`,
    originalMeaning: `${requirement.name} names a Maven artifact`,
    representedMeaning: 'The requirement was not written',
    omittedMeaning:
      'A Maven dependency needs both a groupId and an artifactId; this PURL carried only one',
    mitigation: 'Use a full pkg:maven/<groupId>/<artifactId> PURL.',
    blocksProfile: ['native-capture-v1', 'native-validated-v1'],
  };
}

function buildScriptLoss(path: string): SemanticLoss {
  return {
    code: 'NATIVE_MANIFEST_NOT_WRITABLE',
    severity: 'warning',
    sourceEcosystem: 'maven',
    sourcePath: path,
    originalMeaning:
      'The project declares its dependencies in a Gradle build script',
    representedMeaning: 'Nothing was written',
    omittedMeaning:
      'A Gradle build script is a program, so a dependency can be added by a loop, a function or a convention plugin; editing it as if it were a list would be guessing',
    mitigation:
      'Add a gradle/libs.versions.toml version catalog, which is data and can be maintained safely.',
    blocksProfile: ['native-validated-v1'],
  };
}

function catalogWiringLoss(path: string): SemanticLoss {
  return {
    code: 'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'maven',
    sourcePath: path,
    originalMeaning: 'The dependency is declared in the Gradle version catalog',
    representedMeaning:
      'The catalog entry exists and is referenceable as libs.*',
    omittedMeaning:
      'Adding it to a configuration (implementation, testImplementation) happens in the build script, which opm does not write',
    mitigation:
      'Reference the catalog alias from the build script, for example implementation(libs.<alias>).',
    blocksProfile: [],
  };
}
