/**
 * MSBuild project files as a PREX project format.
 *
 * `dotnet build`, `dotnet restore` and every IDE read the `.csproj`, not
 * `opm.toml`. A dependency opm knows about that is missing from the project
 * file does not exist as far as .NET is concerned.
 *
 * Writing is surgical rather than parse-and-reserialise: a `.csproj` is
 * hand-maintained XML with comments, conditions and an author's formatting, and
 * re-emitting the document would rewrite the whole file for a one-attribute
 * change. `fast-xml-parser` is used to *read* and to prove the result still
 * parses; the edit itself moves only the span it has to.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
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
  applySpanEdits,
  matchFileStyle,
  ProjectIoError,
  readTextFile,
  writeFileAtomic,
  type SpanEdit,
} from '@openpacker/project-io';

const PROJECT_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj'] as const;
const CENTRAL_PROPS = 'Directory.Packages.props';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  isArray: (name) => name === 'PackageReference' || name === 'PackageVersion',
});

export class NugetProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.nuget';
  readonly purlType = 'nuget' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const manifestPath = await findProjectFile(root);
    if (!manifestPath) return undefined;
    const framework = firstTargetFramework(
      await readFile(manifestPath, 'utf8'),
    );

    const centralPath = join(root, CENTRAL_PROPS);
    const central = (await exists(centralPath))
      ? await centralManagementEnabled(centralPath)
      : false;

    return {
      root,
      manifestPath,
      ...(central ? { relatedPaths: { central: centralPath } } : {}),
      metadata: {
        centralPackageManagement: central,
        ...(framework === undefined ? {} : { targetFramework: framework }),
      },
    };
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    const text = await readFile(project.manifestPath, 'utf8');
    const versions = project.relatedPaths?.central
      ? await centralVersions(project.relatedPaths.central)
      : new Map<string, string>();

    const out: NativeRequirement[] = [];
    for (const reference of packageReferences(text)) {
      const range = reference.version ?? versions.get(reference.include);
      out.push({
        purl: `pkg:nuget/${encodeURIComponent(reference.include)}`,
        name: reference.include,
        ...(range === undefined ? {} : { range }),
        // PrivateAssets=all is how MSBuild spells "build-time only".
        scope: reference.privateAssets ? 'development' : 'runtime',
      });
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
    const central = project.relatedPaths?.central;
    const written: string[] = [];

    const wanted = new Map<string, NativeRequirement>();
    for (const requirement of requirements) {
      if (requirement.scope === 'peer' || requirement.scope === 'optional') {
        semanticLoss.push(scopeLoss(requirement));
        continue;
      }
      wanted.set(requirement.name, requirement);
    }

    // Under Central Package Management the version belongs to the props file
    // and the project file carries a bare Include. Writing a Version attribute
    // there is an MSBuild error (NU1008), so the two files are edited as a
    // pair or not at all.
    if (central) {
      if (await editCentralVersions(central, wanted, retire))
        written.push(central);
    }

    if (
      await editProjectReferences(
        project.manifestPath,
        wanted,
        !central,
        retire,
      )
    )
      written.push(project.manifestPath);

    return { written, semanticLoss };
  }

  /**
   * Write `packages.lock.json`.
   *
   * `dotnet restore --locked-mode` compares `contentHash` against the .nupkg it
   * downloads, so an entry without one is refused rather than written blank.
   */
  async writeLockfile(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult> {
    const lockPath = join(project.root, 'packages.lock.json');
    const semanticLoss: SemanticLoss[] = [];
    const dependencies: Record<string, unknown> = {};

    for (const entry of packages) {
      if (
        !entry.nativeIntegrity ||
        entry.nativeIntegrity.encoding !== 'base64'
      ) {
        semanticLoss.push(integrityLoss(entry));
        continue;
      }
      dependencies[entry.name] = {
        type: entry.transitive ? 'Transitive' : 'Direct',
        ...(entry.transitive ? {} : { requested: `[${entry.version}, )` }),
        resolved: entry.version,
        contentHash: entry.nativeIntegrity.value,
      };
    }
    if (semanticLoss.length > 0)
      return {
        written: [],
        skipped: [
          {
            path: lockPath,
            reason: 'not every package carried a NuGet contentHash',
          },
        ],
        semanticLoss,
      };

    const framework = targetFramework(project) ?? 'net8.0';
    const body = {
      version: 1,
      dependencies: { [framework]: dependencies },
    };
    await writeFileAtomic(lockPath, `${JSON.stringify(body, undefined, 2)}\n`);
    return { written: [lockPath], semanticLoss: [] };
  }
}

interface ParsedReference {
  include: string;
  version?: string;
  privateAssets: boolean;
  start: number;
  end: number;
}

/**
 * Locate `<PackageReference .../>` elements and their spans.
 *
 * Deliberately narrow: it matches the element by name and reads its attributes,
 * and anything it cannot match is left alone rather than guessed at.
 */
function packageReferences(text: string): ParsedReference[] {
  const out: ParsedReference[] = [];
  const element =
    /<PackageReference\b[^>]*?(\/>|>[\s\S]*?<\/PackageReference>)/gu;
  for (const match of text.matchAll(element)) {
    const raw = match[0];
    const include = attribute(raw, 'Include') ?? attribute(raw, 'Update');
    if (!include) continue;
    const version = attribute(raw, 'Version');
    out.push({
      include,
      ...(version === undefined ? {} : { version }),
      privateAssets: /PrivateAssets\s*=\s*"[^"]*\ball\b/iu.test(raw),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return out;
}

function attribute(element: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'u').exec(element);
  return match?.[1];
}

async function editProjectReferences(
  path: string,
  wanted: ReadonlyMap<string, NativeRequirement>,
  withVersion: boolean,
  retire: ReadonlySet<string>,
): Promise<boolean> {
  const file = await readTextFile(path);
  const existing = packageReferences(file.text);
  const seen = new Set<string>();
  const edits: SpanEdit[] = [];

  for (const reference of existing) {
    const requirement = wanted.get(reference.include);
    if (!requirement) {
      // Retired: opm wrote this and no longer declares it. Drop the element
      // and the line it sits on, leaving the rest of the group intact.
      if (retire.has(reference.include))
        edits.push({
          start: lineStart(file.text, reference.start),
          end: lineEnd(file.text, reference.end),
          replacement: '',
        });
      continue;
    }
    seen.add(reference.include);
    const replacement = renderReference(
      file.text.slice(reference.start, reference.end),
      requirement,
      withVersion,
    );
    if (replacement !== file.text.slice(reference.start, reference.end))
      edits.push({
        start: reference.start,
        end: reference.end,
        replacement,
      });
  }

  const additions = [...wanted.values()].filter(
    (requirement) => !seen.has(requirement.name),
  );
  let text = applySpanEdits(file.text, edits);
  if (additions.length > 0)
    text = insertReferences(text, additions, withVersion);

  const next = matchFileStyle(file, text);
  if (next === file.text) return false;
  assertParses(path, next);
  await writeFileAtomic(path, next);
  return true;
}

/**
 * Rewrite one element's Version attribute, leaving every other attribute,
 * child element and byte of whitespace exactly where the author put it.
 */
function renderReference(
  element: string,
  requirement: NativeRequirement,
  withVersion: boolean,
): string {
  if (!withVersion)
    // Central management owns the version; strip a stray one so MSBuild does
    // not fail with NU1008.
    return element.replace(/\s+Version\s*=\s*"[^"]*"/u, '');
  const version = requirement.range ?? '*';
  if (/\bVersion\s*=\s*"[^"]*"/u.test(element))
    return element.replace(
      /\bVersion\s*=\s*"[^"]*"/u,
      `Version="${escapeAttribute(version)}"`,
    );
  // No Version yet: put it directly after Include, which is where every
  // template and every `dotnet add package` writes it.
  return element.replace(
    /(\b(?:Include|Update)\s*=\s*"[^"]*")/u,
    `$1 Version="${escapeAttribute(version)}"`,
  );
}

function insertReferences(
  text: string,
  requirements: readonly NativeRequirement[],
  withVersion: boolean,
): string {
  const rendered = requirements
    .map((requirement) => {
      const version =
        withVersion && requirement.range !== undefined
          ? ` Version="${escapeAttribute(requirement.range)}"`
          : withVersion
            ? ' Version="*"'
            : '';
      const priv =
        requirement.scope === 'development'
          ? ' PrivateAssets="all"'
          : requirement.scope === 'build'
            ? ' PrivateAssets="all"'
            : '';
      return `    <PackageReference Include="${escapeAttribute(requirement.name)}"${version}${priv} />`;
    })
    .join('\n');

  // Prefer an ItemGroup that already holds PackageReferences, so a new entry
  // lands beside its siblings instead of in a group of its own.
  const group =
    /<ItemGroup\b[^>]*>[\s\S]*?<PackageReference[\s\S]*?<\/ItemGroup>/u.exec(
      text,
    );
  if (group) {
    const closing = group.index + group[0].lastIndexOf('</ItemGroup>');
    return `${text.slice(0, closing)}${rendered}\n  ${text.slice(closing)}`;
  }
  const projectClose = text.lastIndexOf('</Project>');
  if (projectClose === -1)
    throw new ProjectIoError(
      'INVALID_PROJECT',
      'project',
      'MSBuild project file has no closing </Project> element',
    );
  return `${text.slice(0, projectClose)}  <ItemGroup>\n${rendered}\n  </ItemGroup>\n${text.slice(projectClose)}`;
}

async function editCentralVersions(
  path: string,
  wanted: ReadonlyMap<string, NativeRequirement>,
  retire: ReadonlySet<string>,
): Promise<boolean> {
  const file = await readTextFile(path);
  const element = /<PackageVersion\b[^>]*?(\/>|>[\s\S]*?<\/PackageVersion>)/gu;
  const seen = new Set<string>();
  const edits: SpanEdit[] = [];

  for (const match of file.text.matchAll(element)) {
    const raw = match[0];
    const include = attribute(raw, 'Include');
    if (!include) continue;
    const requirement = wanted.get(include);
    if (!requirement) {
      if (retire.has(include))
        edits.push({
          start: lineStart(file.text, match.index),
          end: lineEnd(file.text, match.index + raw.length),
          replacement: '',
        });
      continue;
    }
    seen.add(include);
    const replacement = raw.replace(
      /\bVersion\s*=\s*"[^"]*"/u,
      `Version="${escapeAttribute(requirement.range ?? '*')}"`,
    );
    if (replacement !== raw)
      edits.push({
        start: match.index,
        end: match.index + raw.length,
        replacement,
      });
  }

  let text = applySpanEdits(file.text, edits);
  const additions = [...wanted.values()].filter(
    (requirement) => !seen.has(requirement.name),
  );
  if (additions.length > 0) {
    const rendered = additions
      .map(
        (requirement) =>
          `    <PackageVersion Include="${escapeAttribute(requirement.name)}" Version="${escapeAttribute(
            requirement.range ?? '*',
          )}" />`,
      )
      .join('\n');
    const group = /<ItemGroup\b[^>]*>[\s\S]*?<\/ItemGroup>/u.exec(text);
    if (group) {
      const closing = group.index + group[0].lastIndexOf('</ItemGroup>');
      text = `${text.slice(0, closing)}${rendered}\n  ${text.slice(closing)}`;
    } else {
      const projectClose = text.lastIndexOf('</Project>');
      text = `${text.slice(0, projectClose)}  <ItemGroup>\n${rendered}\n  </ItemGroup>\n${text.slice(projectClose)}`;
    }
  }

  const next = matchFileStyle(file, text);
  if (next === file.text) return false;
  assertParses(path, next);
  await writeFileAtomic(path, next);
  return true;
}

/**
 * Prove the edit produced XML that still parses.
 *
 * A surgical edit is fast and preserves formatting, but it is text
 * manipulation — this is what stops a malformed result reaching disk.
 */
function assertParses(path: string, text: string): void {
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

/** Start of the line an offset sits on, so a removal takes its indentation. */
function lineStart(text: string, offset: number): number {
  const previous = text.lastIndexOf('\n', offset - 1);
  return previous === -1 ? 0 : previous + 1;
}

/** End of the line an offset sits on, including its newline. */
function lineEnd(text: string, offset: number): number {
  const next = text.indexOf('\n', offset);
  return next === -1 ? text.length : next + 1;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function findProjectFile(root: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) =>
      PROJECT_EXTENSIONS.some((extension) => entry.endsWith(extension)),
    )
    .sort();
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return join(root, candidates[0]!);
  // More than one: only the one named after its directory is unambiguous.
  // Guessing between siblings would write the dependency into a project the
  // caller did not mean.
  const named = candidates.find((entry) =>
    PROJECT_EXTENSIONS.some(
      (extension) => entry === `${basename(root)}${extension}`,
    ),
  );
  return named ? join(root, named) : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function centralManagementEnabled(path: string): Promise<boolean> {
  const text = await readFile(path, 'utf8');
  // Absent property defaults to true in a Directory.Packages.props that
  // declares PackageVersion items, which is how the SDK reads it.
  const explicit =
    /<ManagePackageVersionsCentrally>\s*(true|false)\s*<\/ManagePackageVersionsCentrally>/iu.exec(
      text,
    );
  if (explicit) return explicit[1]!.toLowerCase() === 'true';
  return /<PackageVersion\b/u.test(text);
}

async function centralVersions(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(
    /<PackageVersion\b[^>]*?(\/>|>[\s\S]*?<\/PackageVersion>)/gu,
  )) {
    const include = attribute(match[0], 'Include');
    const version = attribute(match[0], 'Version');
    if (include && version) out.set(include, version);
  }
  return out;
}

function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'nuget',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to the project file',
    omittedMeaning: `MSBuild PackageReference has no equivalent of the "${requirement.scope}" scope`,
    mitigation:
      'Declare the package as runtime or development, which map to PackageReference and PrivateAssets="all".',
    blocksProfile: ['native-validated-v1'],
  };
}

/** The first target framework a project declares, for the lockfile's key. */
function firstTargetFramework(text: string): string | undefined {
  const single = /<TargetFramework>\s*([^<\s]+)\s*<\/TargetFramework>/u.exec(
    text,
  );
  if (single) return single[1];
  const many = /<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/u.exec(
    text,
  );
  return many?.[1]?.split(';')[0]?.trim();
}

function targetFramework(project: DetectedProject): string | undefined {
  const value = project.metadata?.targetFramework;
  return typeof value === 'string' ? value : undefined;
}

function integrityLoss(entry: NativeLockEntry): SemanticLoss {
  return {
    code: 'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
    severity: 'warning',
    sourceEcosystem: 'nuget',
    sourcePath: `/packages/${entry.name}`,
    originalMeaning: `${entry.name} ${entry.version} was resolved and pinned by digest`,
    representedMeaning: 'No packages.lock.json was written',
    omittedMeaning:
      'NuGet pins with a base64 sha512 contentHash over the .nupkg, which was not captured for this package',
    mitigation:
      'Re-resolve so the contentHash is captured, or keep native_projection at "manifest".',
    blocksProfile: ['native-validated-v1'],
  };
}
