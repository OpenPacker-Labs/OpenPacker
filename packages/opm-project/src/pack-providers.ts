import { resolve } from 'node:path';
import {
  type AdapterRegistry,
  getAdapterRegistry,
} from '@openpacker/adapter-host';
import {
  loadDelegatedPackProvider,
  manifestPackagePackers,
  type ManifestPackagePackerDependencies,
} from '@openpacker/pack-provider';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';

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
  const environment = input.environment ?? process.env;
  const loaded = [];
  const defaults = new Map<string, string>();

  for (const [id, source] of Object.entries(
    input.manifest.packProviders ?? {},
  )) {
    let provider;
    const path = resolve(input.root, source.manifest);
    try {
      provider = await loadDelegatedPackProvider(path);
    } catch (error) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Cannot load pack provider ${id} from ${path}: ${message(error)}`,
      );
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
    for (const packer of manifestPackagePackers(
      item.provider,
      input.dependencies,
    ))
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
