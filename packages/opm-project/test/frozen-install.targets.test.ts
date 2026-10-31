import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, setup, storedNames } from './frozen-workspace-fixture.js';

afterEach(cleanup);

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;
const linuxMusl = { os: 'linux', architecture: 'x64', libc: 'musl' } as const;
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

  // A lock written from registry metadata that lacked `libc` (an npm lock, as a
  // pnpm one, often does) lists a musl build as for linux/x64; its own
  // package.json says musl. On a glibc machine it cannot run, and it is not
  // worth the disk it would take in the store (OpenSesame: 322 MiB of them).
  it("leaves out an optional package whose own package.json says another libc than the lock's, and never extracts it", async () => {
    const w = await setup();
    delete w.root.workspaces;
    w.root.optionalDependencies = {
      'native-gnu': '1.0.0',
      'native-musl': '1.0.0',
    };
    const native = (libc: string) => ({
      os: ['linux'],
      cpu: ['x64'],
      libc: [libc],
    });
    w.place(
      'node_modules/native-gnu',
      { name: 'native-gnu', version: '1.0.0', manifest: native('glibc') },
      { optional: true, os: ['linux'], cpu: ['x64'] },
    );
    w.place(
      'node_modules/native-musl',
      { name: 'native-musl', version: '1.0.0', manifest: native('musl') },
      { optional: true, os: ['linux'], cpu: ['x64'] },
    );
    await w.write();

    const result = await w.install({ target: linux });

    expect(await names(w.dir)).toEqual(['native-gnu']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        name: 'native-musl',
        kind: 'platform',
        reason: expect.stringMatching(/libc musl.*its package\.json/u),
      }),
    ]);
    expect(await storedNames(`${w.dir}-store`)).toEqual(['native-gnu']);

    // A store that already holds it (installed for a musl machine) is read,
    // not fetched again, and the package still stays out on this one.
    await rm(join(w.dir, 'node_modules'), { recursive: true });
    await w.install({ target: linux, targets: [linux, linuxMusl] });
    expect(await names(w.dir)).toEqual(['native-gnu', 'native-musl']);
    const fetched = w.registry.requests.length;
    const again = await w.install({ target: linux });
    expect(await names(w.dir)).toEqual(['native-gnu']);
    expect(again.skipped.map((item) => item.name)).toEqual(['native-musl']);
    expect(w.registry.requests.length).toBe(fetched);
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
