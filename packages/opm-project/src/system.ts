import {
  type InstallOptions,
  type InstallOutcome,
  type InstallPlan,
  type InstallerAvailability,
} from '@openpacker/adapter-core';
import { AdapterHostError } from '@openpacker/adapter-host';
import type { PolicyInput } from '@openpacker/contracts';
import { OpmError } from './types.js';
import { ecosystemFromPurl } from './spec.js';
import { requireAdapterRegistry } from './adapters.js';

/**
 * Map a project PolicyInput onto host-installer sandbox options.
 *
 * [sandbox] in opm.toml is load-bearing for apt/winget/choco/nix — without
 * this, those adapters only see their own defaults.
 */
export function hostSandboxFromPolicy(
  policy?: PolicyInput,
): NonNullable<InstallOptions['sandbox']> {
  return {
    mode: policy?.sandboxMode ?? 'fail-closed',
    prefer: policy?.sandboxPrefer ?? 'auto',
    allowHostUnsandboxedInstall: policy?.allowHostUnsandboxedInstall ?? false,
  };
}

/**
 * Host / profile installers discovered through the adapter registry.
 *
 * Prefer unified `opm add` for capability-driven install; these helpers remain
 * as a thin alias for scripts that called `opm system` explicitly.
 */

export async function listSystemInstallers(): Promise<
  {
    id: string;
    purlTypes: readonly string[];
    availability: InstallerAvailability;
  }[]
> {
  const registry = requireAdapterRegistry();
  const out: {
    id: string;
    purlTypes: readonly string[];
    availability: InstallerAvailability;
  }[] = [];
  for (const module of registry.list()) {
    if (!module.installer) continue;
    const definition = await module.registryDefinition();
    const hasInstall = definition.resources.some((resource) => {
      const types = Array.isArray(resource['@type'])
        ? resource['@type']
        : [resource['@type']];
      return types.includes('prex.registry.install/1');
    });
    if (!hasInstall) continue;
    const installer = module.installer();
    out.push({
      id: module.id,
      purlTypes: module.purlTypes,
      availability: await installer.available(),
    });
  }
  return out;
}

export async function planSystemInstall(
  exactPurl: string,
  options: InstallOptions = {},
): Promise<InstallPlan> {
  const ecosystem = ecosystemFromPurl(exactPurl);
  try {
    const installer = await requireAdapterRegistry().installerFor(ecosystem);
    return installer.plan(exactPurl, options);
  } catch (error) {
    if (error instanceof AdapterHostError)
      throw new OpmError(error.code, error.message);
    throw error;
  }
}

export async function installSystemPackage(
  exactPurl: string,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const ecosystem = ecosystemFromPurl(exactPurl);
  try {
    const installer = await requireAdapterRegistry().installerFor(ecosystem);
    const availability = await installer.available(options.signal);
    if (!availability.available)
      throw new OpmError(
        'UNAVAILABLE',
        `${ecosystem} cannot install here: ${availability.reason ?? 'unavailable'}`,
      );
    return installer.install(exactPurl, options);
  } catch (error) {
    if (error instanceof AdapterHostError)
      throw new OpmError(error.code, error.message);
    throw error;
  }
}

/** @deprecated Use listSystemInstallers / adapter purl types. */
export type SystemInstallerId = string;

/** @deprecated Discovery uses the adapter registry. */
export function systemInstallerIdFor(purlOrEcosystem: string): string {
  return purlOrEcosystem.startsWith('pkg:')
    ? ecosystemFromPurl(purlOrEcosystem)
    : purlOrEcosystem;
}
