import { describe, expect, it } from 'vitest';
import { WingetSystemProvider } from './index.js';

/**
 * winget is Windows-only and this suite runs on Linux, so the CLI is injected.
 * These pin the decisions — which argv is built, what is refused, what the
 * install admits it cannot promise — and nothing here has been run against a
 * real winget.
 */

function fakeWinget(responses: Record<string, string> = {}) {
  const calls: string[][] = [];
  const execute = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    const matched =
      responses[key] ??
      responses[Object.keys(responses).find((k) => key.startsWith(k)) ?? ''];
    if (matched === undefined) throw new Error(`no response for ${key}`);
    return { stdout: matched, stderr: '' };
  };
  return { calls, execute };
}

const windows = () => 'win32';

describe('availability', () => {
  it('reports the winget it found', async () => {
    const { execute } = fakeWinget({ 'winget --version': 'v1.8.1911' });
    expect(
      await new WingetSystemProvider(execute, windows).available(),
    ).toMatchObject({
      available: true,
      tool: { name: 'winget', version: '1.8.1911' },
    });
  });

  it('reports that it is Windows-only rather than throwing', async () => {
    // A caller on Linux should be able to pick another provider; that is a
    // fact about the host, not an error.
    const provider = new WingetSystemProvider(
      fakeWinget().execute,
      () => 'linux',
    );
    const availability = await provider.available();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/Windows-only/u);
  });
});

describe('planning', () => {
  it('builds an argv from a Publisher.Package identifier', async () => {
    const provider = new WingetSystemProvider(fakeWinget().execute, windows);
    const plan = await provider.plan('pkg:winget/Git/Git@2.45.1');
    expect(plan.command.slice(0, 6)).toEqual([
      'winget',
      'install',
      '--id',
      'Git.Git',
      '--exact',
      '--version',
    ]);
    expect(plan.command).toContain('2.45.1');
  });

  it('defaults to user scope so an install does not demand admin it does not need', async () => {
    const provider = new WingetSystemProvider(fakeWinget().execute, windows);
    const plan = await provider.plan('pkg:winget/Git/Git');
    expect(plan.command).toContain('user');
    expect(plan.requiresElevation).toBe(false);

    const elevated = await provider.plan('pkg:winget/Git/Git', {
      allowElevation: true,
    });
    expect(elevated.command).toContain('machine');
    expect(elevated.requiresElevation).toBe(true);
  });

  it('states what a system install cannot promise', async () => {
    const provider = new WingetSystemProvider(fakeWinget().execute, windows);
    const plan = await provider.plan('pkg:winget/Git/Git');
    expect(plan.semanticLoss.map((loss) => loss.code)).toEqual([
      'SYSTEM_INSTALL_NOT_BYTE_VERIFIED',
      'SYSTEM_INSTALL_NOT_REVERSIBLE',
    ]);
    expect(
      plan.semanticLoss.some((loss) =>
        loss.blocksProfile.includes('native-validated-v1'),
      ),
    ).toBe(true);
  });

  it('refuses an identifier or version that could act as an option', async () => {
    const provider = new WingetSystemProvider(fakeWinget().execute, windows);
    for (const bad of [
      'pkg:winget/--silent/x',
      'pkg:winget/Git/Git@--force',
      'pkg:winget/Git/Git; rm -rf /',
      'pkg:npm/lodash',
    ])
      await expect(provider.plan(bad), bad).rejects.toMatchObject({
        code: 'INVALID_PURL',
      });
  });
});

describe('installing', () => {
  it('performs nothing on a dry run', async () => {
    const { calls, execute } = fakeWinget({ 'winget --version': 'v1.8' });
    const provider = new WingetSystemProvider(execute, windows);
    const outcome = await provider.install('pkg:winget/Git/Git', {
      dryRun: true,
    });
    expect(outcome.performed).toBe(false);
    expect(calls.some(([, verb]) => verb === 'install')).toBe(false);
  });

  it('refuses the legacy ambient option before executing an install', async () => {
    const { calls, execute } = fakeWinget({ 'winget --version': 'v1.8' });
    const provider = new WingetSystemProvider(execute, windows);
    await expect(
      provider.install('pkg:winget/Nope/Nope', {
        sandbox: { allowHostUnsandboxedInstall: true },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(calls.some(([, verb]) => verb === 'install')).toBe(false);
  });

  it('refuses to run where winget does not exist', async () => {
    const provider = new WingetSystemProvider(
      fakeWinget().execute,
      () => 'linux',
    );
    await expect(provider.install('pkg:winget/Git/Git')).rejects.toMatchObject({
      code: 'UNSUPPORTED_ECOSYSTEM',
    });
  });
});

describe('identifiers', () => {
  it('round-trips a Publisher.Package identifier', () => {
    const provider = new WingetSystemProvider(fakeWinget().execute, windows);
    expect(provider.canonicalPurl('Microsoft.PowerShell', '7.4.3')).toContain(
      'pkg:winget/Microsoft/PowerShell@7.4.3',
    );
    expect(() => provider.canonicalPurl('NoDot')).toThrow(/Publisher/u);
  });
});
