import { describe, expect, it } from 'vitest';
import { AptSystemProvider } from './index.js';

/**
 * Nothing here runs apt. The executor is injected, so these assert the
 * decisions this provider makes — which argv it builds, what it refuses, and
 * what it admits it cannot promise — without changing the machine running the
 * tests.
 */

function fakeApt(
  responses: Record<
    string,
    { stdout?: string; stderr?: string; fail?: unknown }
  > = {},
) {
  const calls: string[][] = [];
  const execute = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    const matched =
      responses[key] ??
      responses[Object.keys(responses).find((k) => key.startsWith(k)) ?? ''];
    if (matched?.fail) throw matched.fail;
    return { stdout: matched?.stdout ?? '', stderr: matched?.stderr ?? '' };
  };
  return { calls, execute };
}

const linux = () => 'linux';

describe('availability', () => {
  it('reports the tool it found', async () => {
    const { execute } = fakeApt({
      'apt-get --version': { stdout: 'apt 2.8.3 (amd64)' },
    });
    const apt = new AptSystemProvider(execute, linux, () => false);
    expect(await apt.available()).toMatchObject({
      available: true,
      tool: { name: 'apt-get', version: '2.8.3' },
    });
  });

  it('reports unavailability instead of throwing, so a caller can pick another provider', async () => {
    const onWindows = new AptSystemProvider(
      fakeApt().execute,
      () => 'win32',
      () => false,
    );
    expect(await onWindows.available()).toMatchObject({ available: false });

    const missing = new AptSystemProvider(
      fakeApt({ 'apt-get --version': { fail: new Error('ENOENT') } }).execute,
      linux,
      () => false,
    );
    expect((await missing.available()).reason).toMatch(/not on PATH/u);
  });
});

describe('planning', () => {
  it('builds an argv, never a shell string', async () => {
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => false);
    const plan = await apt.plan('pkg:deb/curl@8.5.0-2ubuntu10.11');
    expect(plan.command).toEqual([
      'sudo',
      'apt-get',
      'install',
      '--yes',
      'curl=8.5.0-2ubuntu10.11',
    ]);
    expect(plan.requiresElevation).toBe(true);
  });

  it('drops sudo when already root', async () => {
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => true);
    const plan = await apt.plan('pkg:deb/curl');
    expect(plan.command[0]).toBe('apt-get');
    expect(plan.requiresElevation).toBe(false);
  });

  it('states what a system install cannot promise', async () => {
    // The honesty requirement: this is not byte-verified and the generation
    // ledger cannot roll it back, and both are declared rather than implied.
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => false);
    const plan = await apt.plan('pkg:deb/curl');
    expect(plan.irreversible).toBe(true);
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

  it('refuses anything that is not a Debian package name', async () => {
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => false);
    for (const bad of [
      'pkg:deb/curl;rm -rf /',
      'pkg:deb/curl --allow-downgrades',
      'pkg:deb/CURL',
      'pkg:npm/lodash',
    ])
      await expect(apt.plan(bad), bad).rejects.toMatchObject({
        code: 'INVALID_PURL',
      });
  });

  it('refuses a version that is not a Debian version', async () => {
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => false);
    for (const bad of [
      'pkg:deb/curl@1.0 --reinstall',
      // Debian versions start with a digit. Anchoring there is what stops a
      // version ever resembling an option, however it is concatenated later.
      'pkg:deb/curl@--allow-downgrades',
      'pkg:deb/curl@-o',
    ])
      await expect(apt.plan(bad), bad).rejects.toMatchObject({
        code: 'INVALID_PURL',
      });
  });

  it('accepts the Debian versions that are actually legal', async () => {
    const apt = new AptSystemProvider(fakeApt().execute, linux, () => true);
    for (const good of ['8.5.0-2ubuntu10.11', '1:2.39-0ubuntu8', '2.8.3']) {
      const plan = await apt.plan(`pkg:deb/curl@${good}`);
      expect(plan.command.at(-1)).toBe(`curl=${good}`);
    }
  });
});

describe('installing', () => {
  it('refuses to elevate without consent', async () => {
    // A PURL naming a system package is not authorization to change the host.
    const { calls, execute } = fakeApt({
      'apt-get --version': { stdout: 'apt 2.8.3' },
    });
    const apt = new AptSystemProvider(execute, linux, () => false);
    await expect(apt.install('pkg:deb/curl')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(calls.some(([file]) => file === 'sudo')).toBe(false);
  });

  it('performs nothing on a dry run', async () => {
    const { calls, execute } = fakeApt({
      'apt-get --version': { stdout: 'apt 2.8.3' },
    });
    const apt = new AptSystemProvider(execute, linux, () => false);
    const outcome = await apt.install('pkg:deb/curl', { dryRun: true });
    expect(outcome.performed).toBe(false);
    expect(calls.some(([file]) => file === 'sudo')).toBe(false);
  });

  it('runs the planned command once consented, and reports what it settled on', async () => {
    const { calls, execute } = fakeApt({
      'apt-get --version': { stdout: 'apt 2.8.3' },
      'sudo apt-get install --yes curl': { stdout: 'Setting up curl' },
      'apt-cache policy curl': {
        stdout:
          '  Installed: 8.5.0-2ubuntu10.11\n  Candidate: 8.5.0-2ubuntu10.11',
      },
    });
    const apt = new AptSystemProvider(execute, linux, () => false);
    const outcome = await apt.install('pkg:deb/curl', {
      allowElevation: true,
      // Unit tests inject execute(); ambient opt-in exercises that path.
      sandbox: { allowHostUnsandboxedInstall: true },
    });
    expect(outcome.performed).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.installedVersion).toBe('8.5.0-2ubuntu10.11');
    expect(outcome.sandboxEnforced).toBe(false);
    expect(calls).toContainEqual([
      'sudo',
      'apt-get',
      'install',
      '--yes',
      'curl',
    ]);
  });

  it('surfaces a failing install as an outcome rather than a throw', async () => {
    const { execute } = fakeApt({
      'apt-get --version': { stdout: 'apt 2.8.3' },
      'sudo apt-get install': {
        fail: Object.assign(new Error('exit 100'), {
          code: 100,
          stderr: 'E: Unable to locate package nope',
        }),
      },
    });
    const apt = new AptSystemProvider(execute, linux, () => false);
    const outcome = await apt.install('pkg:deb/nope', {
      allowElevation: true,
      sandbox: { allowHostUnsandboxedInstall: true },
    });
    expect(outcome.exitCode).toBe(100);
    expect(outcome.stderr).toMatch(/Unable to locate/u);
  });

  it('refuses to run at all where apt does not exist', async () => {
    const apt = new AptSystemProvider(
      fakeApt().execute,
      () => 'darwin',
      () => false,
    );
    await expect(
      apt.install('pkg:deb/curl', { allowElevation: true }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ECOSYSTEM' });
  });
});
