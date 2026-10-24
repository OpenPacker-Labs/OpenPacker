/**
 * Every bin the package declares, started the way a package manager starts it:
 * Node on a link to the built file. Node then resolves the link for the module's
 * URL while `process.argv[1]` keeps the link's own path, and a file that
 * decides it is the process entry by comparing the two silently runs nothing.
 *
 * This runs the build output, not the sources: `turbo run test` builds first,
 * and a missing build fails here with the command that makes it.
 */
import { readFileSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT_TOOL_PURL,
  appRoot,
  linkBins,
  makeExitToolProject,
  run,
} from './bins-fixture.js';
import { makeProject } from './run-fixture.js';

// SAFETY: package.json declares `bin` as a map from bin name to built file.
const { bin } = JSON.parse(
  readFileSync(join(appRoot, 'package.json'), 'utf8'),
) as { bin: Record<string, string> };

async function started(name: string): Promise<string> {
  const entry = (await linkBins({ [name]: bin[name]! })).get(name);
  if (entry === undefined) throw new Error(`no link was made for ${name}`);
  return entry;
}

beforeAll(async () => {
  for (const target of Object.values(bin))
    await access(join(appRoot, target)).catch(() => {
      throw new Error(
        `${target} is not built; run: npm run build -w @openpacker/opm`,
      );
    });
});

describe('the bins', () => {
  it('are the ones this suite walks', () => {
    expect(Object.keys(bin).sort()).toEqual(['opkg', 'opkgm', 'opm', 'opmx']);
  });

  it.each(Object.keys(bin))('%s is started through a link', async (name) => {
    const entry = await started(name);
    const file = await realpath(join(appRoot, bin[name]!));
    expect(await realpath(entry)).toBe(file);
    expect(entry).not.toBe(file);
  });
});

describe.each(['opm', 'opkg', 'opkgm'])(
  '%s through a link',
  { timeout: 60_000 },
  (name) => {
    it('prints its help', async () => {
      const finished = await run(
        await started(name),
        ['--help'],
        await makeProject(),
      );
      expect(finished.stdout).toMatch(/^opm — Open Package Manager\n/u);
      expect(finished.stderr).toBe('');
      expect(finished.status).toBe(0);
    });

    it('exits 2 and says what is wrong on a usage error', async () => {
      const finished = await run(
        await started(name),
        ['exec'],
        await makeProject(),
      );
      expect(finished.stderr).toContain('opm exec requires an executable');
      expect(finished.stdout).toBe('');
      expect(finished.status).toBe(2);
    });

    it('passes on the exit code of a script that fails', async () => {
      const root = await makeProject({ scripts: { fail: 'node fail.cjs 7' } });
      const finished = await run(await started(name), ['run', 'fail'], root);
      expect(finished.stderr).toBe('opm: script "fail" exited with code 7\n');
      expect(finished.status).toBe(7);
    });

    it('passes on the exit code of an executable that fails', async () => {
      const finished = await run(
        await started(name),
        ['exec', 'fake-tool', '--exit', '5'],
        await makeProject(),
      );
      expect(finished.stderr).toBe('');
      expect(finished.status).toBe(5);
    });
  },
);

describe('opmx through a link', { timeout: 60_000 }, () => {
  it('prints its help', async () => {
    const finished = await run(
      await started('opmx'),
      ['--help'],
      await makeProject(),
    );
    expect(finished.stdout).toMatch(/^opmx — execute a package binary\n/u);
    expect(finished.stderr).toBe('');
    expect(finished.status).toBe(0);
  });

  it('prints its help and exits 2 when given nothing to run', async () => {
    const finished = await run(await started('opmx'), [], await makeProject());
    expect(finished.stdout).toMatch(/^opmx — execute a package binary\n/u);
    expect(finished.status).toBe(2);
  });

  it('exits 2 and says what is wrong on a usage error', async () => {
    const finished = await run(
      await started('opmx'),
      ['--plugin'],
      await makeProject(),
    );
    expect(finished.stderr).toContain('opmx --plugin requires a plugin name');
    expect(finished.stdout).toBe('');
    expect(finished.status).toBe(2);
  });

  it('exits 4 outside a project', async () => {
    const finished = await run(
      await started('opmx'),
      ['some-tool'],
      await makeProject(),
    );
    expect(finished.stderr).toMatch(/^opmx: No opm\.toml found from /u);
    expect(finished.stdout).toBe('');
    expect(finished.status).toBe(4);
  });

  // `opm` installs the tool and `opmx` runs it, both through their links. The
  // run goes through the sandbox funnel, which refuses (exit 6) on a host that
  // has no containment backend: that host proves the entry reached the
  // library and reported, and a host with one proves the tool's own exit code
  // arrives. Neither may be silence.
  it('runs an installed tool and passes on its exit code', async () => {
    const links = await linkBins(bin);
    const project = await makeExitToolProject();
    const init = await run(
      links.get('opm')!,
      ['init', '--name', 'exit-tool-project'],
      project,
    );
    expect(init.status, init.stderr).toBe(0);
    const added = await run(
      links.get('opm')!,
      ['add', EXIT_TOOL_PURL, '--offline'],
      project,
    );
    expect(added.status, added.stderr).toBe(0);

    const ran = await run(links.get('opmx')!, ['exit-tool', '3'], project);
    if (ran.stderr.includes('sandbox was not enforced')) {
      expect(ran.stdout).toBe('');
      expect(ran.status).toBe(6);
    } else {
      expect(ran.stderr).toBe('');
      expect(ran.stdout).toBe('exit-tool ran\n');
      expect(ran.status).toBe(3);
    }
  });
});
