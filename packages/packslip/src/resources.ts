import type { Artifact, ReleaseStatement, Resource } from './types.js';

/** Formats that are the executable itself: no archive path can name anything in them. */
const BARE_FORMATS = new Set(['raw', 'gz', 'xz', 'zst', 'bz2']);

/**
 * Source priority once scope and specificity have narrowed the choices: the
 * most verifiable first. `archive` is covered by the artifact's own digest,
 * `asset` by its own signed digest, `repo` by the pinned source commit, and
 * `exec` by nothing but trust in the verified executable.
 */
const SOURCE_PRIORITY = { archive: 0, asset: 1, repo: 2, exec: 4 } as const;

/** One thing the release ships, with every entry that can supply it. */
export interface ResourceGroup {
  readonly kind: string;
  /** What makes two entries alternatives for the same thing. */
  readonly identity: string;
  /** Surviving entries, most verifiable source first, then document order. */
  readonly alternatives: readonly Resource[];
}

function applies(resource: Resource, artifact: Artifact): boolean {
  if (resource.artifact !== undefined && resource.artifact !== artifact.name)
    return false;
  for (const field of ['os', 'arch', 'libc'] as const)
    if (resource[field] !== undefined && resource[field] !== artifact[field])
      return false;
  // An archive path inside a bare executable names nothing.
  if (resource.source.kind === 'archive' && BARE_FORMATS.has(artifact.format))
    return false;
  return true;
}

/** `artifact`-scoped entries outrank every platform-only scope. */
function specificity(resource: Resource): [number, number] {
  const platform = [resource.os, resource.arch, resource.libc].filter(
    (value) => value !== undefined,
  ).length;
  return [resource.artifact === undefined ? 0 : 1, platform];
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * The identities an entry competes under. A release with a single executable
 * lets `bin` be omitted, and the entry then competes with one that names it.
 * An `exec` completion generating several shells has one identity per shell.
 */
function identities(
  resource: Resource,
  soleExecutable: string | undefined,
): string[] {
  const bin = resource.bin ?? soleExecutable ?? '';
  switch (resource.kind) {
    case 'completion':
      return resource.source.kind === 'exec'
        ? (resource.shells ?? []).map((shell) => `${bin}\0${shell}`)
        : [`${bin}\0${resource.shell ?? ''}`];
    case 'man':
      return [
        resource.source.kind === 'exec'
          ? bin
          : `${bin}\0${baseName(sourcePath(resource))}`,
      ];
    case 'cli-spec':
      return [`${resource.bin ?? ''}\0${resource.format ?? ''}`];
    case 'skill':
      return [resource.name ?? ''];
    case 'sbom':
      return [resource.format ?? ''];
    default:
      return [
        resource.source.kind === 'exec' ? '' : baseName(sourcePath(resource)),
      ];
  }
}

function sourcePath(resource: Resource): string {
  switch (resource.source.kind) {
    case 'archive':
    case 'repo':
      return resource.source.path;
    case 'asset':
      return resource.source.name;
    case 'exec':
      return '';
  }
}

function executableNames(statement: ReleaseStatement): string[] {
  return [
    ...new Set(
      statement.artifacts.flatMap(
        (artifact) => artifact.bin?.map((bin) => bin.name) ?? [],
      ),
    ),
  ];
}

/**
 * For every thing the release describes, the entries that apply to the
 * selected artifact: scoped to it, then the most specific, then ordered by how
 * verifiable their source is. Entries for different things never hide one
 * another, and equally specific entries for the same thing are alternatives.
 */
export function selectResources(
  statement: ReleaseStatement,
  artifact: Artifact,
): ResourceGroup[] {
  const executables = executableNames(statement);
  const sole = executables.length === 1 ? executables[0] : undefined;
  const byIdentity = new Map<string, { kind: string; entries: Resource[] }>();
  for (const resource of statement.resources) {
    if (!applies(resource, artifact)) continue;
    for (const identity of identities(resource, sole)) {
      const key = `${resource.kind}\0${identity}`;
      const group = byIdentity.get(key) ?? { kind: resource.kind, entries: [] };
      group.entries.push(resource);
      byIdentity.set(key, group);
    }
  }
  const groups: ResourceGroup[] = [];
  for (const [key, group] of byIdentity) {
    const best = group.entries.reduce<[number, number]>(
      (top, entry) => {
        const level = specificity(entry);
        return level[0] > top[0] || (level[0] === top[0] && level[1] > top[1])
          ? level
          : top;
      },
      [0, 0],
    );
    const survivors = group.entries.filter((entry) => {
      const level = specificity(entry);
      return level[0] === best[0] && level[1] === best[1];
    });
    survivors.sort(
      (left, right) =>
        SOURCE_PRIORITY[left.source.kind] -
          SOURCE_PRIORITY[right.source.kind] || left.index - right.index,
    );
    groups.push({
      kind: group.kind,
      identity: key.slice(group.kind.length + 1),
      alternatives: survivors,
    });
  }
  return groups;
}

/** Positions in `predicate.resources` of every surviving entry, in document order. */
export function survivingIndexes(groups: readonly ResourceGroup[]): number[] {
  return [
    ...new Set(
      groups.flatMap((group) => group.alternatives.map((entry) => entry.index)),
    ),
  ].sort((left, right) => left - right);
}
