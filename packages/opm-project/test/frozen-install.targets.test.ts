import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, setup } from './frozen-workspace-fixture.js';

afterEach(cleanup);

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;
const mac = { os: 'darwin', architecture: 'arm64' } as const;

/** An npm project with an optional package for each of two platforms. */
async function fixture() {
  const w = await setup();
  delete w.root.workspaces;
  w.root.optionalDependencies = {
    'native-linux': '1.0.0',
    'native-mac': '1.0.0',
  };
  w.place(
    'node_modules/native-linux',
    { name: 'native-linux', version: '1.0.0' },
    { optional: true, os: ['linux'] },
  );
  w.place(
    'node_modules/native-mac',
    { name: 'native-mac', version: '1.0.0' },
    { optional: true, os: ['darwin'] },
  );
  await w.write();
  return w;
}

const names = async (dir: string) =>
  (await readdir(join(dir, 'node_modules')))
    .filter((name) => !name.startsWith('.'))
    .sort();

describe('installFrozen of an npm lock for several machines', () => {
  it('installs the host alone by default', async () => {
    const w = await fixture();
    await w.install({ target: linux });
    expect(await names(w.dir)).toEqual(['native-linux']);
  });

  it('installs an optional package that runs on any one of the machines it is told', async () => {
    const w = await fixture();
    const result = await w.install({ target: linux, targets: [linux, mac] });
    expect(await names(w.dir)).toEqual(['native-linux', 'native-mac']);
    expect(result.skipped).toEqual([]);
  });

  it('names the machines when a package that is not optional runs on none of them', async () => {
    const w = await setup();
    delete w.root.workspaces;
    w.root.dependencies = { 'only-mac': '1.0.0' };
    w.place(
      'node_modules/only-mac',
      { name: 'only-mac', version: '1.0.0' },
      { os: ['darwin'] },
    );
    await w.write();
    await expect(
      w.install({ target: linux, targets: [linux] }),
    ).rejects.toThrow(
      /not this machine \(linux\/x64\/glibc\), and is not optional/u,
    );
    await expect(stat(join(w.dir, 'node_modules'))).rejects.toThrow();
  });

  it('has no supportedArchitectures to take from a package.json, and says what to use', async () => {
    const w = await fixture();
    await expect(
      w.install({ target: linux, architectures: 'project' }),
    ).rejects.toThrow(
      /a package\.json has no supportedArchitectures setting[\s\S]*--os, --cpu and --libc/u,
    );
  });
});
