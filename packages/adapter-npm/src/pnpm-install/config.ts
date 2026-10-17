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

import { ProviderError } from '@openpacker/adapter-core';
import { MAXIMUM_MANIFEST_BYTES, readBounded } from '../frozen-read.js';
import { quote } from './quote.js';
import { readWorkspaceFile } from './workspace-file.js';

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
  /** The patches the project declares, by `name@version` or name. */
  readonly patches: readonly string[];
  /** The root `package.json`'s own name and version, for a `parent>name` override. */
  readonly project: { readonly name?: string; readonly version?: string };
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
  const overrides = new Map<string, string>([
    ...strings(manifest['resolutions'], 'package.json resolutions'),
    ...strings(pnpm['overrides'], 'package.json pnpm.overrides'),
    ...strings(workspace['overrides'], 'pnpm-workspace.yaml overrides'),
  ]);
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
  const patches = [
    ...strings(pnpm['patchedDependencies'], 'pnpm.patchedDependencies').keys(),
    ...strings(
      workspace['patchedDependencies'],
      'pnpm-workspace.yaml patchedDependencies',
    ).keys(),
  ];
  const own = (key: 'name' | 'version') =>
    typeof manifest[key] === 'string' ? { [key]: manifest[key] } : {};
  return {
    project: { ...own('name'), ...own('version') },
    overrides: resolveReferences(overrides, rootSpecifiers),
    catalogs,
    supportedArchitectures:
      architectures(
        workspace['supportedArchitectures'],
        'pnpm-workspace.yaml supportedArchitectures',
      ) ??
      architectures(
        pnpm['supportedArchitectures'],
        'package.json pnpm.supportedArchitectures',
      ),
    patches,
  };
}
