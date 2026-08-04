import { describe, expect, it } from 'vitest';
import {
  listSystemInstallers,
  planSystemInstall,
  systemInstallerIdFor,
} from '../src/index.js';

describe('system installer routing via adapter registry', () => {
  it('maps PURLs to purl types', () => {
    expect(systemInstallerIdFor('pkg:deb/curl')).toBe('deb');
    expect(systemInstallerIdFor('pkg:nix/hello')).toBe('nix');
    expect(systemInstallerIdFor('pkg:winget/Microsoft.PowerShell')).toBe(
      'winget',
    );
    expect(systemInstallerIdFor('pkg:chocolatey/git')).toBe('chocolatey');
  });

  it('lists install-capable adapters from discovery', async () => {
    const list = await listSystemInstallers();
    const ids = list.map((entry) => entry.id).sort();
    expect(ids.some((id) => id.includes('nix'))).toBe(true);
    expect(ids.some((id) => id.includes('apt') || id.includes('deb'))).toBe(
      true,
    );
    expect(ids.some((id) => id.includes('chocolatey'))).toBe(true);
    for (const entry of list) {
      expect(typeof entry.availability.available).toBe('boolean');
    }
  });

  it('plans a nix install through the registry', async () => {
    const plan = await planSystemInstall('pkg:nix/hello');
    expect(plan.requiresElevation).toBe(false);
    expect(plan.command).toEqual(
      expect.arrayContaining(['nix', 'profile', 'install']),
    );
  });

  it('refuses install planning when resource is missing for catalog-only types', async () => {
    await expect(
      planSystemInstall('pkg:npm/lodash@1.0.0'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
