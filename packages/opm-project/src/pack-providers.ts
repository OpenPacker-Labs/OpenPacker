import { basename, dirname, join } from 'node:path';
import {
  type AdapterRegistry,
  getAdapterRegistry,
} from '@openpacker/adapter-host';
import {
  parseDelegatedPackProvider,
  manifestPackagePackers,
  type ManifestPackagePackerDependencies,
} from '@openpacker/pack-provider';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';
import {
  assertContainedRelativePath,
  openStableDirectory,
  readStableFileAt,
} from './paths.js';

export interface ConfiguredPackProviders {
  authorizedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export async function configurePackProviders(input: {
  root: string;
  manifest: OpmManifest;
  registry?: AdapterRegistry;
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: ManifestPackagePackerDependencies;
}): Promise<ConfiguredPackProviders> {
  const registry = input.registry ?? getAdapterRegistry();
  // Ambient process.env is not consent. Embedders may pass an already
  // authorized value map; the CLI passes none until it grows an explicit grant.
  const environment = input.environment ?? {};
  const loaded = [];
  const defaults = new Map<string, string>();

  for (const [id, source] of Object.entries(
    input.manifest.packProviders ?? {},
  )) {
    let provider;
    // Manifest paths may span several segments (`.opm/providers/acme.json`)
    // but must stay contained beneath the project root. The loader still gets
    // a path, but one anchored at a stable no-follow directory handle, so a
    // symlinked or swapped intermediate component fails closed instead of
    // redirecting the read.
    const displayPath = join(
      input.root,
      assertContainedRelativePath(source.manifest, 'pack provider manifest'),
    );
    const directory = await openStableDirectory(dirname(displayPath));
    try {
      provider = parseDelegatedPackProvider(
        JSON.parse(await readStableFileAt(directory, basename(displayPath))),
      );
    } catch (error) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Cannot load pack provider ${id} from ${displayPath}: ${message(error)}`,
      );
    } finally {
      await directory.close();
    }
    if (provider.id !== id)
      throw new OpmError(
        'INVALID_MANIFEST',
        `Pack provider key ${id} does not match manifest id ${provider.id}`,
      );
    unique(source.defaultFor ?? [], `${id}.default_for`);
    unique(source.allowEnvironment ?? [], `${id}.allow_environment`);
    for (const purlType of source.defaultFor ?? []) {
      if (!provider.purlTypes.includes(purlType))
        throw new OpmError(
          'INVALID_MANIFEST',
          `Pack provider ${id} does not declare default purl type ${purlType}`,
        );
      const existing = defaults.get(purlType);
      if (existing !== undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Pack providers ${existing} and ${id} both default purl type ${purlType}`,
        );
      defaults.set(purlType, id);
    }
    const authorized: Record<string, string> = {};
    for (const name of source.allowEnvironment ?? []) {
      if (!provider.authority.environment.includes(name))
        throw new OpmError(
          'INVALID_MANIFEST',
          `Pack provider ${id} does not declare environment variable ${name}`,
        );
      const value = environment[name];
      if (value !== undefined) authorized[name] = value;
    }
    loaded.push({ provider, source, authorized });
  }

  const authorizedEnvironment: Record<
    string,
    Readonly<Record<string, string>>
  > = {};
  for (const item of loaded) {
    authorizedEnvironment[item.provider.id] = item.authorized;
    for (const packer of manifestPackagePackers(item.provider, {
      ...(input.dependencies ?? {}),
      executablePath: item.source.executable,
    }))
      registry.registerPackProvider(packer, {
        makeDefault: item.source.defaultFor?.includes(packer.purlType) === true,
      });
  }
  return { authorizedEnvironment };
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new OpmError(
      'INVALID_MANIFEST',
      `${label} must contain unique names`,
    );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
