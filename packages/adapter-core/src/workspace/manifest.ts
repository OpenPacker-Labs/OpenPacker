import type { JsonValue } from '@openpacker/contracts';
import { WorkspaceError } from './errors.js';
import type { WorkspaceLimits } from './limits.js';

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** Dependency name to the specifier the manifest wrote, in file order. */
export type DependencyMap = ReadonlyMap<string, string>;

/**
 * What the workspace model keeps of a `package.json`: enough to name the
 * package, find what it depends on and tell a nested workspace declaration. It
 * is a reading of the file, not the file: scripts, exports and every other
 * field are not carried.
 */
export interface WorkspaceManifest {
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly private: boolean;
  readonly dependencies: DependencyMap;
  readonly devDependencies: DependencyMap;
  readonly optionalDependencies: DependencyMap;
  readonly peerDependencies: DependencyMap;
  /** Peers `peerDependenciesMeta` marks `optional: true`. */
  readonly optionalPeers: ReadonlySet<string>;
  /** The `workspaces` field, when the manifest declares one. */
  readonly workspaces: JsonValue | undefined;
  /**
   * The executables it declares, name to path inside the package, as
   * `npm-normalize-package-bin` reads `bin`: a string is named for the package
   * (its last name segment), an object is taken as it is. Empty when there are
   * none, or when `bin` is neither.
   */
  readonly bin: Readonly<Record<string, string>>;
  /**
   * `publishConfig.directory`, when it is a string: pnpm links such a member
   * from that directory and records it in its lock as `publishDirectory`.
   */
  readonly publishDirectory?: string;
}

type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

function invalid(where: string, problem: string): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_MANIFEST_INVALID',
    `${where}: ${problem}`,
    [where],
  );
}

function dependencyMap(
  value: JsonValue | undefined,
  field: string,
  where: string,
  limits: WorkspaceLimits,
): DependencyMap {
  if (value === undefined) return new Map();
  if (!isJsonObject(value)) throw invalid(where, `${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > limits.maxDependencyEntries)
    throw new WorkspaceError(
      'WORKSPACE_LIMIT_EXCEEDED',
      `${where}: ${field} lists ${entries.length} entries, more than the limit of ${limits.maxDependencyEntries}`,
      [where],
    );
  const map = new Map<string, string>();
  for (const [name, specifier] of entries) {
    if (!isJsonString(specifier))
      throw invalid(
        where,
        `${field}[${JSON.stringify(name)}] must be a string specifier`,
      );
    map.set(name, specifier);
  }
  return map;
}

function optionalPeerNames(
  value: JsonValue | undefined,
  where: string,
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!isJsonObject(value))
    throw invalid(where, 'peerDependenciesMeta must be an object');
  const names = new Set<string>();
  for (const [name, entry] of Object.entries(value))
    if (isJsonObject(entry) && entry['optional'] === true) names.add(name);
  return names;
}

function binMap(
  value: JsonValue | undefined,
  name: string | undefined,
): Readonly<Record<string, string>> {
  if (isJsonString(value))
    return value === '' || name === undefined
      ? {}
      : { [name.split('/').at(-1)!]: value };
  if (!isJsonObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(value))
    if (isJsonString(path)) out[key] = path;
  return out;
}

/**
 * Read a parsed `package.json`. `where` is the path the text came from and is
 * how every message names it. A field of the wrong type is refused, not
 * ignored: a dependency list that is half understood would give a graph that
 * is silently missing edges.
 */
export function readWorkspaceManifest(
  value: JsonValue,
  where: string,
  limits: WorkspaceLimits,
): WorkspaceManifest {
  if (!isJsonObject(value)) throw invalid(where, 'must be a JSON object');
  const name = value['name'];
  if (name !== undefined && !isJsonString(name))
    throw invalid(where, 'name must be a string');
  const version = value['version'];
  if (version !== undefined && !isJsonString(version))
    throw invalid(where, 'version must be a string');
  const flag = value['private'];
  const publish = value['publishConfig'];
  const publishDirectory = isJsonObject(publish)
    ? publish['directory']
    : undefined;
  return {
    name,
    version,
    private: flag === true,
    dependencies: dependencyMap(
      value['dependencies'],
      'dependencies',
      where,
      limits,
    ),
    devDependencies: dependencyMap(
      value['devDependencies'],
      'devDependencies',
      where,
      limits,
    ),
    optionalDependencies: dependencyMap(
      value['optionalDependencies'],
      'optionalDependencies',
      where,
      limits,
    ),
    peerDependencies: dependencyMap(
      value['peerDependencies'],
      'peerDependencies',
      where,
      limits,
    ),
    optionalPeers: optionalPeerNames(value['peerDependenciesMeta'], where),
    workspaces: value['workspaces'],
    bin: binMap(value['bin'], name),
    ...(isJsonString(publishDirectory) && { publishDirectory }),
  };
}

/**
 * The patterns of a `package.json` `workspaces` field: an array, or the object
 * form `{ "packages": [...] }` Yarn and npm both read (its other keys, such as
 * Yarn 1's `nohoist`, do not select members and are ignored). Anything else is
 * refused.
 */
export function workspacePatternsOf(
  value: JsonValue,
  where: string,
): readonly string[] {
  const list = Array.isArray(value)
    ? value
    : isJsonObject(value)
      ? value['packages']
      : undefined;
  if (
    list === undefined ||
    !Array.isArray(list) ||
    !list.every((entry) => isJsonString(entry))
  )
    throw new WorkspaceError(
      'WORKSPACE_DECLARATION_INVALID',
      `${where}: workspaces must be an array of patterns, or an object whose "packages" is one`,
      [where],
    );
  return list.filter(isJsonString);
}
