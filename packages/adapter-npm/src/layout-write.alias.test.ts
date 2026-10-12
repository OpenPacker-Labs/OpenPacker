import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  NativeLayoutMember,
  NativeLockEntry,
} from '@openpacker/adapter-core';
import { LAYOUT_RECORD, writeNodeModules } from './layout-write.js';
import { MEMBER, cleanup, project } from './layout-write-links-support.js';

afterEach(cleanup);

/** Shims are run through `sh`; the Windows leg writes `.cmd` files and does not run them here. */
const onPosix = it.skipIf(process.platform === 'win32');

const DIR = 'packages/member';
const member: NativeLayoutMember = { dir: DIR, name: 'member', bin: {} };

/**
 * A package a lock places at `at`. `name` is what the package calls itself, so
 * for an aliased dependency it is not the last name of `at`: `string-width`
 * placed at `…/node_modules/string-width-cjs`.
 */
async function placed(
  p: Awaited<ReturnType<typeof project>>,
  name: string,
  at: string,
  version: string,
  files: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<NativeLockEntry> {
  const entry = await p.store(
    name,
    {
      'index.js': `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`,
      ...files,
    },
    { version, ...extra },
  );
  const installName = at.split('/node_modules/').at(-1)!;
  return {
    ...entry,
    version,
    layoutPath: at,
    alias: at,
    ...(installName !== name && { installName }),
  };
}

const write = (
  p: Awaited<ReturnType<typeof project>>,
  entries: NativeLockEntry[],
) => writeNodeModules(p.root, entries, { links: [MEMBER], members: [member] });

const resolveIn = (cwd: string, script: string) =>
  execFileSync(process.execPath, ['-e', script], {
    cwd,
    encoding: 'utf8',
  }).trim();

const recordIn = async (modules: string) =>
  JSON.parse(await readFile(join(modules, LAYOUT_RECORD), 'utf8')) as {
    packages: string[];
    bins: string[];
  };

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('an alias in the node_modules of a workspace member', () => {
  it('is a directory named by the alias, beside the package of its own name', async () => {
    const p = await project();
    const mine = join(p.member, 'node_modules');
    const outcome = await write(p, [
      await placed(p, 'string-width', 'node_modules/string-width', '5.1.2'),
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width-cjs`,
        '4.2.3',
      ),
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width`,
        '6.0.0',
      ),
    ]);
    expect(outcome.packages).toBe(3);
    expect(outcome.memberModules).toBe(1);
    expect(await readdir(mine)).toEqual([
      '.opm-layout.json',
      'string-width',
      'string-width-cjs',
    ]);
    expect(resolveIn(p.root, "console.log(require('string-width'))")).toBe(
      'string-width@5.1.2',
    );
    expect(resolveIn(p.member, "console.log(require('string-width'))")).toBe(
      'string-width@6.0.0',
    );
    expect(
      resolveIn(p.member, "console.log(require('string-width-cjs'))"),
    ).toBe('string-width@4.2.3');
    // The package behind the alias still says what it is.
    expect(
      JSON.parse(
        await readFile(join(mine, 'string-width-cjs', 'package.json'), 'utf8'),
      ).name,
    ).toBe('string-width');
  });

  it("is recorded under the alias, which is the directory, not the package's own name", async () => {
    const p = await project();
    await write(p, [
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width-cjs`,
        '4.2.3',
      ),
      await placed(p, 'plain', `${DIR}/node_modules/plain`, '1.0.0'),
    ]);
    expect((await recordIn(join(p.member, 'node_modules'))).packages).toEqual([
      'plain',
      'string-width-cjs',
    ]);
  });

  it('is taken away by a later layout that no longer has it, and nothing else is', async () => {
    const p = await project();
    const mine = join(p.member, 'node_modules');
    await write(p, [
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width-cjs`,
        '4.2.3',
      ),
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width`,
        '6.0.0',
      ),
    ]);
    await write(p, [
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width`,
        '6.0.0',
      ),
    ]);
    expect(await exists(join(mine, 'string-width-cjs'))).toBe(false);
    expect(await readdir(mine)).toEqual(['.opm-layout.json', 'string-width']);
    expect((await recordIn(mine)).packages).toEqual(['string-width']);
  });

  it('is taken away the other way round too: the unaliased package goes, the alias stays', async () => {
    const p = await project();
    const mine = join(p.member, 'node_modules');
    const alias = () =>
      placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width-cjs`,
        '4.2.3',
      );
    await write(p, [
      await alias(),
      await placed(
        p,
        'string-width',
        `${DIR}/node_modules/string-width`,
        '6.0.0',
      ),
    ]);
    await write(p, [await alias()]);
    expect(await readdir(mine)).toEqual([
      '.opm-layout.json',
      'string-width-cjs',
    ]);
    expect(
      resolveIn(p.member, "console.log(require('string-width-cjs'))"),
    ).toBe('string-width@4.2.3');
  });

  onPosix(
    'has its executables in the .bin beside it, addressing the directory it is in',
    async () => {
      const p = await project();
      const cli =
        "#!/usr/bin/env node\nconsole.log('padded', process.argv[2])\n";
      await write(p, [
        await placed(
          p,
          'left-pad',
          `${DIR}/node_modules/pad`,
          '0.9.0',
          { 'cli.js': cli },
          { bin: { padcli: 'cli.js' } },
        ),
      ]);
      const bin = join(p.member, 'node_modules', '.bin');
      const shim = join(bin, 'padcli');
      expect(await readFile(shim, 'utf8')).toContain("'/../pad/cli.js'");
      expect(execFileSync('sh', [shim, 'x'], { encoding: 'utf8' })).toBe(
        'padded x\n',
      );
      expect((await recordIn(join(p.member, 'node_modules'))).bins).toEqual([
        'padcli',
      ]);
    },
  );

  onPosix(
    'names a string bin after the package, not after the alias, and puts it in the alias directory',
    async () => {
      const p = await project();
      await write(p, [
        await placed(
          p,
          'left-pad',
          `${DIR}/node_modules/pad`,
          '0.9.0',
          { 'cli.js': "console.log('bare')\n" },
          { bin: 'cli.js' },
        ),
      ]);
      const shim = join(p.member, 'node_modules', '.bin', 'left-pad');
      expect(await exists(join(p.member, 'node_modules', '.bin', 'pad'))).toBe(
        false,
      );
      expect(execFileSync('sh', [shim], { encoding: 'utf8' })).toBe('bare\n');
    },
  );
});

describe('an alias in the node_modules of the project', () => {
  it('is recorded under the alias, with the member beside it unaffected', async () => {
    const p = await project();
    await write(p, [
      await placed(p, 'string-width', 'node_modules/string-width-cjs', '4.2.3'),
      await placed(p, 'own', `${DIR}/node_modules/own`, '1.0.0'),
    ]);
    expect((await recordIn(p.modules)).packages).toEqual(['string-width-cjs']);
    expect((await recordIn(join(p.member, 'node_modules'))).packages).toEqual([
      'own',
    ]);
  });
});

describe('an executable name two packages declare, one of them aliased', () => {
  const cli = (who: string) => ({
    'cli.js': `console.log(${JSON.stringify(who)})\n`,
  });
  const tool = { bin: { tool: 'cli.js' } };

  // By their own names `alpha` sorts before `zeta`; by the directories they are
  // in, `aa` sorts before `alpha`. The directory is what the shim names.
  onPosix(
    'goes by the directory, not by what the package calls itself',
    async () => {
      const p = await project();
      const outcome = await write(p, [
        await placed(p, 'zeta', 'node_modules/aa', '1.0.0', cli('zeta'), tool),
        await placed(
          p,
          'alpha',
          'node_modules/alpha',
          '1.0.0',
          cli('alpha'),
          tool,
        ),
      ]);
      const shim = join(p.modules, '.bin', 'tool');
      expect(await readFile(shim, 'utf8')).toContain("'/../aa/cli.js'");
      expect(execFileSync('sh', [shim], { encoding: 'utf8' })).toBe('zeta\n');
      expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
        'alpha also declares tool; aa keeps it',
      ]);
    },
  );

  onPosix(
    'still lets a direct requirement keep it over an aliased transitive one',
    async () => {
      const p = await project();
      const aliased = await placed(
        p,
        'zeta',
        'node_modules/aa',
        '1.0.0',
        cli('zeta'),
        tool,
      );
      const outcome = await write(p, [
        { ...aliased, transitive: true },
        await placed(
          p,
          'alpha',
          'node_modules/zzz',
          '1.0.0',
          cli('alpha'),
          tool,
        ),
      ]);
      expect(
        execFileSync('sh', [join(p.modules, '.bin', 'tool')], {
          encoding: 'utf8',
        }),
      ).toBe('alpha\n');
      expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
        'aa also declares tool; zzz keeps it',
      ]);
    },
  );
});
