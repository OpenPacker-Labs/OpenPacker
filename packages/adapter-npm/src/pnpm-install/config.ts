/**
 * The settings a pnpm project keeps outside its lock, as far as a frozen
 * install needs them (ADR 0055 §18, §19).
 *
 * pnpm reads them from the root `package.json` (`pnpm.overrides`,
 * `resolutions`, `pnpm.supportedArchitectures`, `pnpm.patchedDependencies`) and
 * from `pnpm-workspace.yaml` (`overrides`, `catalog`, `catalogs`,
 * `supportedArchitectures`, `patchedDependencies`), the file winning where both
 * say a thing. `.npmrc` is not read. Nothing here is applied: a frozen install
 * installs what the lock says, and these are only compared with it, or, for the
 * architectures, used to widen the platforms when asked.
 */

import { ProviderError, type FrozenLock } from '@openpacker/adapter-core';
import { MAXIMUM_MANIFEST_BYTES, readBounded } from '../frozen-read.js';
import { quote } from './quote.js';
import { readWorkspaceFile } from './workspace-file.js';
import { approvedBuildsOf } from '../approved-builds.js';

/** Platforms a project asks pnpm to install optional packages for. */
export interface SupportedArchitectures {
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly libc: readonly string[];
}

export interface PnpmProjectConfig {
  /** Selector to replacement, merged the way pnpm merges the places it is written. */
  readonly overrides: ReadonlyMap<string, string>;
  /** Catalog name (`default` for the unnamed one) to dependency to specifier. */
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly supportedArchitectures: SupportedArchitectures | undefined;
  /** The patches the project declares: key (`name@version`, a range or a name) to path. */
  readonly patches: ReadonlyMap<string, string>;
  /** Where `patches` were read: the root `package.json`'s or the workspace file's. */
  readonly patchesFrom:
    | 'package.json pnpm.patchedDependencies'
    | 'pnpm-workspace.yaml patchedDependencies';
  /** The packages whose install scripts the project approved (`approved-builds.ts`). */
  readonly approvedBuilds?: NonNullable<FrozenLock['approvedBuilds']>;
  /** `ignoredOptionalDependencies`, which opm does not apply. */
  readonly ignoredOptionalDependencies: readonly string[];
  /**
   * The root `package.json`'s own name and version, for a `parent>name`
   * override, and its `publishConfig.directory`.
   */
  readonly project: {
    readonly name?: string;
    readonly version?: string;
    readonly publishDirectory?: string;
  };
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, where: string): ReadonlyMap<string, string> {
  if (value === undefined || value === null) return new Map();
  if (!isRecord(value))
    throw new ProviderError('INVALID_MANIFEST', `${where} must be an object`);
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string')
      throw new ProviderError(
        'INVALID_MANIFEST',
        `${where}[${quote(key)}] must be a string`,
      );
    out.set(key, entry);
  }
  return out;
}

function list(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${where} must be a list of strings`,
    );
  return value as string[];
}

function architectures(
  value: unknown,
  where: string,
): SupportedArchitectures | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    throw new ProviderError('INVALID_MANIFEST', `${where} must be an object`);
  return {
    os: list(value['os'], `${where}.os`) ?? ['current'],
    cpu: list(value['cpu'], `${where}.cpu`) ?? ['current'],
    libc: list(value['libc'], `${where}.libc`) ?? ['current'],
  };
}

/** Parse JSON text into a record, or say why not. */
function parseRecord(text: string, path: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed))
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} must be a JSON object`,
    );
  return parsed;
}

/** `$name` in an override is the specifier the root manifest gives `name`. */
function resolveReferences(
  overrides: ReadonlyMap<string, string>,
  rootSpecifiers: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(
    [...overrides].map(([selector, value]) => [
      selector,
      value.startsWith('$')
        ? (rootSpecifiers.get(value.slice(1)) ?? value)
        : value,
    ]),
  );
}

/**
 * Read the root `package.json` and `pnpm-workspace.yaml` of the project in
 * `root`. `rootSpecifiers` is the root manifest's dependencies by name, for the
 * `$name` form of an override.
 */
export async function readPnpmProjectConfig(
  root: string,
  manifestPath: string,
  rootSpecifiers: ReadonlyMap<string, string>,
): Promise<PnpmProjectConfig> {
  const manifest = parseRecord(
    await readBounded(manifestPath, MAXIMUM_MANIFEST_BYTES),
    manifestPath,
  );
  const pnpm = isRecord(manifest['pnpm']) ? manifest['pnpm'] : {};
  const workspace = await readWorkspaceFile(root);
  // pnpm 10 reads the workspace file's settings, then puts the root
  // manifest's over them whole (getOptionsFromRootManifest): when package.json
  // has any override (`resolutions`, then `pnpm.overrides`), the file's are
  // not merged in but replaced.
  const fromManifest = new Map<string, string>([
    ...strings(manifest['resolutions'], 'package.json resolutions'),
    ...strings(pnpm['overrides'], 'package.json pnpm.overrides'),
  ]);
  const overrides =
    fromManifest.size > 0
      ? fromManifest
      : strings(workspace['overrides'], 'pnpm-workspace.yaml overrides');
  const catalogs = new Map<string, ReadonlyMap<string, string>>();
  const unnamed = strings(workspace['catalog'], 'pnpm-workspace.yaml catalog');
  if (unnamed.size > 0) catalogs.set('default', unnamed);
  const named = workspace['catalogs'];
  if (isRecord(named))
    for (const [name, entries] of Object.entries(named))
      catalogs.set(
        name,
        strings(entries, `pnpm-workspace.yaml catalogs[${quote(name)}]`),
      );
  // As for overrides: the root manifest's setting, when it has the key at all,
  // is spread over the workspace file's whole (getOptionsFromRootManifest).
  const patchesFrom =
    'patchedDependencies' in pnpm
      ? ('package.json pnpm.patchedDependencies' as const)
      : ('pnpm-workspace.yaml patchedDependencies' as const);
  const patches = strings(
    'patchedDependencies' in pnpm
      ? pnpm['patchedDependencies']
      : workspace['patchedDependencies'],
    patchesFrom,
  );
  const own = (key: 'name' | 'version') =>
    typeof manifest[key] === 'string' ? { [key]: manifest[key] } : {};
  const publish = isRecord(manifest['publishConfig'])
    ? manifest['publishConfig']['directory']
    : undefined;
  const approvedBuilds = approvedBuildsOf(manifest, workspace);
  return {
    ...(approvedBuilds !== undefined && { approvedBuilds }),
    project: {
      ...own('name'),
      ...own('version'),
      ...(typeof publish === 'string' && { publishDirectory: publish }),
    },
    ignoredOptionalDependencies:
      list(
        pnpm['ignoredOptionalDependencies'],
        'package.json pnpm.ignoredOptionalDependencies',
      ) ??
      list(
        workspace['ignoredOptionalDependencies'],
        'pnpm-workspace.yaml ignoredOptionalDependencies',
      ) ??
      [],
    overrides: resolveReferences(overrides, rootSpecifiers),
    catalogs,
    // The root manifest's over the file's, as for overrides.
    supportedArchitectures:
      architectures(
        pnpm['supportedArchitectures'],
        'package.json pnpm.supportedArchitectures',
      ) ??
      architectures(
        workspace['supportedArchitectures'],
        'pnpm-workspace.yaml supportedArchitectures',
      ),
    patches,
    patchesFrom,
  };
}
