import {
  type InstallOptions,
  type InstallOutcome,
  type InstallPlan,
  type InstallerAvailability,
  type InstallerProvider,
} from '@openpacker/adapter-core';
import { AptSystemProvider } from '@openpacker/adapter-apt';
import { NixStoreProvider } from '@openpacker/adapter-nix';
import { WingetSystemProvider } from '@openpacker/adapter-winget';
import { OpmError } from './types.js';
import { ecosystemFromPurl } from './spec.js';

/**
 * Host installers that change the machine through a native tool.
 *
 * apt, nix and winget are not catalog providers: they install onto the host
 * and run maintainer scripts / profile changes. Routing them here rather than
 * through the project store is what keeps those effects honest — the project
 * store is content-addressed and rollback-able; a system install is neither.
 */

export type SystemInstallerId = 'apt' | 'nix' | 'winget';

const BY_ECOSYSTEM: Readonly<Record<string, SystemInstallerId>> = {
  deb: 'apt',
  apt: 'apt',
  nix: 'nix',
  winget: 'winget',
};

export function systemInstallerIdFor(
  purlOrEcosystem: string,
): SystemInstallerId {
  const ecosystem = purlOrEcosystem.startsWith('pkg:')
    ? ecosystemFromPurl(purlOrEcosystem)
    : purlOrEcosystem;
  const id = BY_ECOSYSTEM[ecosystem];
  if (!id)
    throw new OpmError(
      'UNSUPPORTED_ECOSYSTEM',
      `"${ecosystem}" is not a system installer. Supported: deb/apt, nix, winget.`,
    );
  return id;
}

export function systemInstaller(id: SystemInstallerId): InstallerProvider {
  switch (id) {
    case 'apt':
      return new AptSystemProvider();
    case 'nix':
      return new NixStoreProvider();
    case 'winget':
      return new WingetSystemProvider();
  }
}

export async function listSystemInstallers(): Promise<
  {
    id: SystemInstallerId;
    availability: InstallerAvailability;
  }[]
> {
  const ids: SystemInstallerId[] = ['apt', 'nix', 'winget'];
  return Promise.all(
    ids.map(async (id) => ({
      id,
      availability: await systemInstaller(id).available(),
    })),
  );
}

export async function planSystemInstall(
  exactPurl: string,
  options: InstallOptions = {},
): Promise<InstallPlan> {
  const id = systemInstallerIdFor(exactPurl);
  return systemInstaller(id).plan(exactPurl, options);
}

export async function installSystemPackage(
  exactPurl: string,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const id = systemInstallerIdFor(exactPurl);
  const provider = systemInstaller(id);
  const availability = await provider.available(options.signal);
  if (!availability.available)
    throw new OpmError(
      'UNAVAILABLE',
      `${id} cannot install here: ${availability.reason ?? 'unavailable'}`,
    );
  return provider.install(exactPurl, options);
}
