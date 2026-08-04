import { describe, expect, it } from 'vitest';
import {
  listSystemInstallers,
  planSystemInstall,
  systemInstallerIdFor,
} from '../src/index.js';

describe('system installer routing', () => {
  it('maps PURLs to installer ids', () => {
    expect(systemInstallerIdFor('pkg:deb/curl')).toBe('apt');
    expect(systemInstallerIdFor('pkg:nix/hello')).toBe('nix');
    expect(systemInstallerIdFor('pkg:winget/Microsoft.PowerShell')).toBe(
      'winget',
    );
    expect(systemInstallerIdFor('nix')).toBe('nix');
  });

  it('refuses ecosystems that are not host installers', () => {
    expect(() => systemInstallerIdFor('pkg:npm/lodash')).toThrow(
      /not a system installer/i,
    );
  });

  it('reports availability for every installer without throwing', async () => {
    const list = await listSystemInstallers();
    expect(list.map((entry) => entry.id).sort()).toEqual([
      'apt',
      'nix',
      'winget',
    ]);
    for (const entry of list) {
      expect(typeof entry.availability.available).toBe('boolean');
      if (!entry.availability.available)
        expect(entry.availability.reason).toBeTruthy();
    }
  });

  it('plans a nix install without elevation', async () => {
    const plan = await planSystemInstall('pkg:nix/hello');
    expect(plan.requiresElevation).toBe(false);
    expect(plan.command).toEqual(
      expect.arrayContaining(['nix', 'profile', 'install', 'nixpkgs#hello']),
    );
    expect(plan.semanticLoss.map((loss) => loss.code)).toContain(
      'NIX_RESOLUTION_DELEGATED',
    );
  });
});
