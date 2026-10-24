import type { JsonValue } from '@openpacker/contracts';
import {
  assertStatementFrame,
  decodeEvidence,
  decodeIdentity,
  decodeSubjects,
  timestamp,
  token,
} from './decode.js';
import { PackslipError } from './errors.js';
import { ObjectReader, isJsonObject } from './json.js';
import { parseProject } from './project.js';
import type {
  Artifact,
  AttestedBy,
  BinEntry,
  HostRequirements,
  ReleaseStatement,
  RequiredCommand,
  Resource,
  ResourceSource,
  SourceInfo,
  Subject,
} from './types.js';
import { RELEASE_PREDICATE } from './types.js';
import { assertSemver } from './version.js';
import { shown } from './shown.js';

function invalid(message: string): PackslipError {
  return new PackslipError('INVALID_STATEMENT', message);
}

/** Archive entry names use `/`; PowerShell 5.1 writes `\` into ZIP names. */
function archivePath(reader: ObjectReader, key: string, raw: string): string {
  const path = raw.replaceAll('\\', '/');
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes('\0') ||
    segments.some((part) => part === '' || part === '.' || part === '..')
  )
    throw reader.fail(
      `${reader.path}.${key}`,
      `"${shown(raw)}" must be a relative path inside the archive`,
    );
  return path;
}

/** A command name is the name as typed: no separator, never `.exe`. */
function commandName(reader: ObjectReader, key: string, raw: string): string {
  const name = raw.endsWith('.exe') ? raw.slice(0, -'.exe'.length) : raw;
  if (name === '' || /[\\/\0]/u.test(name))
    throw reader.fail(
      `${reader.path}.${key}`,
      `"${shown(raw)}" must be a command name, not a path`,
    );
  return name;
}

function decodeBin(
  artifact: ObjectReader,
  values: readonly JsonValue[],
): BinEntry[] {
  return values.map((value, index) => {
    if (typeof value === 'string') {
      const holder = new ObjectReader({}, `${artifact.path}.bin[${index}]`);
      const path = archivePath(holder, 'path', value);
      const base = path.split('/').pop() ?? path;
      return { path, name: commandName(holder, 'name', base) };
    }
    const entry = artifact.element('bin', index, values);
    return {
      path: archivePath(entry, 'path', entry.string('path')),
      name: commandName(entry, 'name', entry.string('name')),
    };
  });
}

function decodeRequires(artifact: ObjectReader): HostRequirements | undefined {
  const reader = artifact.optionalObject('requires');
  if (reader === undefined) return undefined;
  const osMin = reader.optionalString('os_min');
  const glibcMin = reader.optionalString('glibc_min');
  const libs = reader.optionalStringArray('libs');
  const binValues = reader.optionalArray('bin');
  const bin: RequiredCommand[] | undefined = binValues?.map((_, index) => {
    const entry = reader.element('bin', index, binValues);
    const min = entry.optionalString('min');
    return {
      name: commandName(entry, 'name', entry.string('name')),
      ...(min !== undefined && { min }),
    };
  });
  return {
    ...(osMin !== undefined && { osMin }),
    ...(glibcMin !== undefined && { glibcMin }),
    ...(libs !== undefined && { libs }),
    ...(bin !== undefined && { bin }),
  };
}

function decodeArtifact(
  parent: ObjectReader,
  values: readonly JsonValue[],
  index: number,
): Artifact {
  const reader = parent.element('artifacts', index, values);
  const os = token(reader, 'os');
  const arch = token(reader, 'arch');
  const libc = token(reader, 'libc');
  const variant = token(reader, 'variant');
  const format = token(reader, 'format');
  if (format === undefined)
    throw reader.fail(`${reader.path}.format`, 'must be a non-empty string');
  const url = reader.optionalString('url');
  const binValues = reader.optionalArray('bin');
  const provenance = reader.optionalStringArray('provenance');
  const requires = decodeRequires(reader);
  const extensions = reader.optionalExtensions();
  return {
    name: reader.string('name'),
    ...(os !== undefined && { os }),
    ...(arch !== undefined && { arch }),
    ...(libc !== undefined && { libc }),
    ...(variant !== undefined && { variant }),
    size: reader.integer('size'),
    ...(url !== undefined && { url }),
    format,
    ...(binValues !== undefined && { bin: decodeBin(reader, binValues) }),
    ...(requires !== undefined && { requires }),
    ...(provenance !== undefined && { provenance }),
    ...(extensions !== undefined && { extensions }),
  };
}

function decodeSource(reader: ObjectReader): ResourceSource {
  const archive = reader.optionalString('archive');
  const asset = reader.optionalString('asset');
  const repo = reader.optionalString('repo');
  const exec = reader.optionalStringArray('exec');
  const present = [archive, asset, repo, exec].filter(
    (value) => value !== undefined,
  ).length;
  if (present !== 1)
    throw reader.fail(
      reader.path,
      'must choose exactly one of archive, asset, repo, and exec',
    );
  const url = reader.optionalString('url');
  const env = reader.optionalStringRecord('env');
  if (url !== undefined && asset === undefined)
    throw reader.fail(`${reader.path}.url`, 'is only allowed with asset');
  if (env !== undefined && exec === undefined)
    throw reader.fail(`${reader.path}.env`, 'is only allowed with exec');
  if (archive !== undefined)
    return { kind: 'archive', path: archivePath(reader, 'archive', archive) };
  if (asset !== undefined)
    return { kind: 'asset', name: asset, ...(url !== undefined && { url }) };
  if (repo !== undefined)
    return { kind: 'repo', path: archivePath(reader, 'repo', repo) };
  if (exec === undefined || exec.length === 0)
    throw reader.fail(`${reader.path}.exec`, 'must not be empty');
  return {
    kind: 'exec',
    argv: exec,
    ...(env !== undefined && { env }),
  };
}

function decodeResource(
  parent: ObjectReader,
  values: readonly JsonValue[],
  index: number,
): Resource {
  const reader = parent.element('resources', index, values);
  const kind = reader.string('kind');
  const source = decodeSource(reader);
  const shell = reader.optionalString('shell');
  const shells = reader.optionalStringArray('shells');
  const format = reader.optionalString('format');
  const bin = reader.optionalString('bin');
  const name = reader.optionalString('name');
  const artifact = reader.optionalString('artifact');
  const os = token(reader, 'os');
  const arch = token(reader, 'arch');
  const libc = token(reader, 'libc');
  const extensions = reader.optionalExtensions();

  if (kind === 'completion') {
    if (source.kind === 'exec') {
      if (shell !== undefined || shells === undefined || shells.length === 0)
        throw reader.fail(
          reader.path,
          'an exec completion lists every shell it generates in "shells"',
        );
      const placeholder =
        source.argv.some((part) => part.includes('{shell}')) ||
        Object.values(source.env ?? {}).some((part) =>
          part.includes('{shell}'),
        );
      if (!placeholder)
        throw reader.fail(
          reader.path,
          'an exec completion substitutes {shell} in argv or env',
        );
    } else if (shell === undefined || shells !== undefined) {
      throw reader.fail(
        reader.path,
        'a static completion names exactly one "shell"',
      );
    }
  }
  if (kind === 'cli-spec' && (bin === undefined || format === undefined))
    throw reader.fail(reader.path, 'a cli-spec needs "bin" and "format"');
  if (kind === 'sbom') {
    if (format !== 'cyclonedx' && format !== 'spdx')
      throw reader.fail(reader.path, 'an sbom format is cyclonedx or spdx');
    if (source.kind === 'exec')
      throw reader.fail(
        reader.path,
        'an sbom comes from archive, asset, or repo, never exec',
      );
  }
  if (kind === 'skill' && name === undefined)
    throw reader.fail(reader.path, 'a skill needs a "name"');
  if (kind === 'app' && source.kind !== 'archive')
    throw reader.fail(reader.path, 'an app comes from an archive path only');

  return {
    kind,
    index,
    source,
    ...(artifact !== undefined && { artifact }),
    ...(os !== undefined && { os }),
    ...(arch !== undefined && { arch }),
    ...(libc !== undefined && { libc }),
    ...(shell !== undefined && { shell }),
    ...(shells !== undefined && { shells }),
    ...(format !== undefined && { format }),
    ...(bin !== undefined && { bin }),
    ...(name !== undefined && { name }),
    ...(extensions !== undefined && { extensions }),
  };
}

function decodeSourceInfo(
  reader: ObjectReader | undefined,
): SourceInfo | undefined {
  if (reader === undefined) return undefined;
  const commit = reader.optionalString('commit');
  const tag = reader.optionalString('tag');
  return {
    repo: reader.string('repo'),
    ...(commit !== undefined && { commit }),
    ...(tag !== undefined && { tag }),
  };
}

function attestedBy(reader: ObjectReader): AttestedBy {
  const value = reader.optionalString('attested_by') ?? 'vendor';
  if (value !== 'vendor' && value !== 'repackager')
    throw reader.fail(
      `${reader.path}.attested_by`,
      'must be vendor or repackager',
    );
  return value;
}

/**
 * Every rule that decides whether a statement is acceptable once its
 * signature has been verified, and before anything is installed. Passing the
 * JSON schema is not enough: the cross-references between subjects, artifacts
 * and resources are what bind each download to a signed digest.
 */
function checkRelations(
  subjects: readonly Subject[],
  artifacts: readonly Artifact[],
  resources: readonly Resource[],
  source: SourceInfo | undefined,
): void {
  if (artifacts.length === 0)
    throw invalid('predicate.artifacts must not be empty');
  const subjectNames = new Set(subjects.map((subject) => subject.name));
  const artifactNames = new Set<string>();
  const kinds = new Set<string>();
  for (const artifact of artifacts) {
    if (artifactNames.has(artifact.name))
      throw invalid(`artifact "${shown(artifact.name)}" appears twice`);
    artifactNames.add(artifact.name);
    if (!subjectNames.has(artifact.name))
      throw invalid(`artifact "${shown(artifact.name)}" has no subject digest`);
    // Two artifacts nothing tells apart cannot be chosen between.
    const kind = [
      artifact.os,
      artifact.arch,
      artifact.libc,
      artifact.variant,
      artifact.format,
    ].join('\0');
    if (kinds.has(kind))
      throw invalid(
        `artifact "${artifact.name}" shares os, arch, libc, variant, and format with another artifact`,
      );
    kinds.add(kind);
  }
  const assets = new Set<string>();
  const binNames = new Set(
    artifacts.flatMap((artifact) => artifact.bin?.map((bin) => bin.name) ?? []),
  );
  for (const resource of resources) {
    if (resource.source.kind === 'asset') assets.add(resource.source.name);
    if (resource.source.kind === 'repo' && source?.commit === undefined)
      throw invalid(
        `resource ${resource.index} comes from the repository, which needs predicate.source.commit`,
      );
    if (
      resource.source.kind === 'exec' &&
      !binNames.has(resource.source.argv[0] ?? '')
    )
      throw invalid(
        `resource ${resource.index} runs "${resource.source.argv[0]}", which is not an executable of the release`,
      );
    if (resource.artifact !== undefined) {
      const target = artifacts.find(
        (artifact) => artifact.name === resource.artifact,
      );
      if (target === undefined)
        throw invalid(
          `resource ${resource.index} names artifact "${resource.artifact}", which does not exist`,
        );
      for (const field of ['os', 'arch', 'libc'] as const)
        if (resource[field] !== undefined && resource[field] !== target[field])
          throw invalid(
            `resource ${resource.index} is scoped to ${field} ${resource[field]} but names an artifact that is not`,
          );
    }
  }
  for (const asset of assets)
    if (!subjectNames.has(asset))
      throw invalid(`resource asset "${asset}" has no subject digest`);
  for (const subject of subjects)
    if (!artifactNames.has(subject.name) && !assets.has(subject.name))
      throw invalid(
        `subject "${subject.name}" is neither an artifact nor a resource asset`,
      );
}

export function decodeReleaseStatement(value: JsonValue): ReleaseStatement {
  if (!isJsonObject(value)) throw invalid('the statement must be an object');
  const root = new ObjectReader(value, '');
  assertStatementFrame(root, RELEASE_PREDICATE);
  const subjects = decodeSubjects(root);
  const predicate = root.object('predicate');
  const project = predicate.string('project');
  try {
    parseProject(project);
  } catch (error) {
    throw invalid(
      `predicate.project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = predicate.string('version');
  assertSemver(version, 'predicate.version');
  const artifactValues = predicate.array('artifacts');
  const artifacts = artifactValues.map((_, index) =>
    decodeArtifact(predicate, artifactValues, index),
  );
  const resourceValues = predicate.optionalArray('resources') ?? [];
  const resources = resourceValues.map((_, index) =>
    decodeResource(predicate, resourceValues, index),
  );
  const source = decodeSourceInfo(predicate.optionalObject('source'));
  checkRelations(subjects, artifacts, resources, source);
  const notesUrl = predicate.optionalString('notes_url');
  const extensions = predicate.optionalExtensions();
  return {
    subjects,
    project,
    version,
    publishedAt: timestamp(predicate, 'published_at'),
    ...(notesUrl !== undefined && { notesUrl }),
    ...(source !== undefined && { source }),
    artifacts,
    resources,
    identity: decodeIdentity(predicate),
    attestedBy: attestedBy(predicate),
    evidence: decodeEvidence(
      predicate,
      'evidence',
      predicate.optionalArray('evidence'),
    ),
    ...(extensions !== undefined && { extensions }),
  };
}
