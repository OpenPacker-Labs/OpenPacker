/**
 * The registry auth configuration is read the way it is written (ADR 0034,
 * trusted bases): its directory is opened, judged this user's alone and
 * taken as opm's configuration root ('config root'), and the file is opened
 * through that directory's handle without following a link. A configuration
 * that names which token goes to which origin is never read through a link a
 * checkout holds, from a directory others may write, or through a link in
 * place of the file.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBases } from '@openpacker/project-io';
import { readAuthConfig } from '../src/auth-config.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const PLANTED = `${JSON.stringify({
  version: 1,
  origins: { 'https://attacker.example': { tokenEnv: 'GITHUB_TOKEN' } },
})}\n`;

const worlds: string[] = [];
afterEach(async () => {
  forgetBases();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-auth-read-'));
  worlds.push(dir);
  return dir;
}

/** `<dir>/openpacker/auth.json` holding the planted configuration, its directory mode 0700. */
async function planted(dir: string): Promise<void> {
  await mkdir(join(dir, 'openpacker'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'openpacker', 'auth.json'), PLANTED, {
    mode: 0o600,
  });
}

describe.runIf(POSIX)('readAuthConfig', () => {
  it('reads nothing through a link a checkout holds where XDG_CONFIG_HOME points', async () => {
    const base = await world();
    const checkout = join(base, 'checkout');
    await mkdir(join(checkout, '.git'), { recursive: true });
    await planted(join(base, 'outside'));
    await symlink(join(base, 'outside'), join(checkout, '.config'));

    await expect(
      readAuthConfig({ env: { XDG_CONFIG_HOME: join(checkout, '.config') } }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('reads no configuration from a directory others may write', async () => {
    const base = await world();
    await planted(base);
    await chmod(join(base, 'openpacker'), 0o777);

    await expect(
      readAuthConfig({ path: join(base, 'openpacker', 'auth.json') }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('reads no file that is a link', async () => {
    const base = await world();
    await planted(join(base, 'elsewhere'));
    await mkdir(join(base, 'config'), { mode: 0o700 });
    await symlink(
      join(base, 'elsewhere', 'openpacker', 'auth.json'),
      join(base, 'config', 'auth.json'),
    );

    await expect(
      readAuthConfig({ path: join(base, 'config', 'auth.json') }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('reads the person’s own configuration through a link of theirs, and none where there is none', async () => {
    const base = await world();
    await planted(join(base, 'config-real'));
    await mkdir(join(base, 'home'));
    await symlink(join(base, 'config-real'), join(base, 'home', '.config'));

    await expect(
      readAuthConfig({
        env: { XDG_CONFIG_HOME: join(base, 'home', '.config') },
      }),
    ).resolves.toEqual(JSON.parse(PLANTED));
    await expect(
      readAuthConfig({
        path: join(base, 'missing', 'openpacker', 'auth.json'),
      }),
    ).resolves.toEqual({ version: 1, origins: {} });
  });
});
