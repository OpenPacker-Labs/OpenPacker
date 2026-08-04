import { describe, expect, it } from 'vitest';
import { ChocolateyProvider } from './index.js';

describe('ChocolateyProvider', () => {
  it('reports unavailable off Windows', async () => {
    const provider = new ChocolateyProvider(
      async () => {
        throw new Error('ENOENT');
      },
      () => 'linux',
    );
    const availability = await provider.available();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/Windows/i);
  });

  it('plans install with elevation and honesty loss', async () => {
    const provider = new ChocolateyProvider(async () => ({
      stdout: '2.2.2',
      stderr: '',
    }));
    const plan = await provider.plan('pkg:chocolatey/git@2.40.0');
    expect(plan.command).toEqual([
      'choco',
      'install',
      'git',
      '-y',
      '--version',
      '2.40.0',
    ]);
    expect(plan.requiresElevation).toBe(true);
    expect(plan.semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'SYSTEM_INSTALL_NOT_BYTE_VERIFIED',
        'SYSTEM_INSTALL_NOT_REVERSIBLE',
      ]),
    );
  });

  it('refuses install without elevation consent', async () => {
    const provider = new ChocolateyProvider(
      async () => ({ stdout: '2.2.2', stderr: '' }),
      () => 'win32',
    );
    await expect(
      provider.install('pkg:chocolatey/git', { allowElevation: false }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
