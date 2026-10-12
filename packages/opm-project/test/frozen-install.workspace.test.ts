import { execFileSync } from 'node:child_process';
import { mkdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  exists,
  onPosix,
  standard,
} from './frozen-workspace-fixture.js';

afterEach(cleanup);

describe('installFrozen on a workspace lock', () => {
  it('links each member to its directory and gives it the node_modules the lock describes', async () => {
    const w = await standard();
    await w.write();

    const result = await w.install();

    expect(result.workspace).toEqual({ members: 2, linked: 2 });
    expect(result.installed).toBe(6);
    expect(await w.isLink('node_modules/one')).toBe(true);
    // A junction (Windows) holds an absolute path.
    if (process.platform !== 'win32')
      expect(await readlink(join(w.dir, 'node_modules', 'one'))).toBe(
        '../packages/one',
      );
    expect(w.run("console.log(require('one'), require('two'))")).toBe(
      'member one member two',
    );
    // Each member finds its own version first, the project's second, and the
    // other member through the project's link.
    expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
      'left@0.9.0',
    );
    expect(w.run("console.log(require('left'))")).toBe('left@1.0.0');
    expect(
      w.run("console.log(require('two'), require('a'))", 'packages/one'),
    ).toBe('member two a@1.0.0');
    expect(await w.isLink('packages/one/node_modules/left')).toBe(false);
  });

  it('never fetches a member, and runs none of its scripts', async () => {
    const w = await standard();
    await w.write();
    await w.install();
    expect(w.registry.requests.some((url) => /\/(one|two)\//u.test(url))).toBe(
      false,
    );
    expect(w.registry.requests).toHaveLength(6);
    expect(await exists(join(w.dir, 'packages', 'one', 'ran'))).toBe(false);
  });

  onPosix(
    "shims the executables of a member in the project's .bin, which run the member's script",
    async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'packages/two/bin'), { recursive: true });
      await writeFile(
        join(w.dir, 'packages/two/bin/two.js'),
        "#!/usr/bin/env node\nconsole.log('two ran', process.argv.slice(2).join())\n",
      );
      const result = await w.install();
      expect(await w.isLink('node_modules/.bin/two')).toBe(false);
      expect(
        execFileSync('sh', [join(w.dir, 'node_modules/.bin/two'), 'x'], {
          encoding: 'utf8',
        }),
      ).toBe('two ran x\n');
      expect(result.layout.semanticLoss[0]?.representedMeaning).toMatch(
        /2 workspace member\(s\) linked to their own directories, 1 with a node_modules of their own/u,
      );
    },
  );

  it("clears every member's node_modules and the project's first, as npm ci does", async () => {
    const w = await standard();
    await w.write();
    for (const stale of [
      'node_modules/stale',
      'packages/one/node_modules/stale',
      'packages/two/node_modules/stale',
    ]) {
      await mkdir(join(w.dir, stale), { recursive: true });
      await writeFile(join(w.dir, stale, 'package.json'), '{}');
    }
    await w.install();
    expect(await w.list('node_modules')).not.toContain('stale');
    expect(await w.list('packages/one/node_modules')).toEqual([
      '.opm-layout.json',
      'left',
    ]);
    // `two` has no packages of its own, so it has no node_modules now.
    expect(await exists(join(w.dir, 'packages/two/node_modules'))).toBe(false);
  });

  it('does it again for nothing', async () => {
    const w = await standard();
    await w.write();
    await w.install();
    const first = await w.list('node_modules');
    const again = await w.install();
    expect(await w.list('node_modules')).toEqual(first);
    expect(again.fetched).toBe(0);
    expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
      'left@0.9.0',
    );
  });

  describe('--workspace', () => {
    it('installs the named member and what it needs, and clears the others', async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'packages/one/node_modules/stale'), {
        recursive: true,
      });
      const result = await w.install({ workspace: { select: ['two'] } });
      expect(result.workspace).toEqual({ members: 2, linked: 1 });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['b', 'dd', 'two']);
      expect(await exists(join(w.dir, 'packages/one/node_modules'))).toBe(
        false,
      );
      expect(result.skipped.filter((s) => s.kind === 'workspace')).toHaveLength(
        4,
      );
    });

    it('takes a directory, and the directory of its members', async () => {
      const w = await standard();
      await w.write();
      const byDirectory = await w.install({
        workspace: { select: ['packages/two'] },
      });
      const byParent = await w.install({ workspace: { select: ['packages'] } });
      expect(byDirectory.workspace?.linked).toBe(1);
      expect(byParent.workspace?.linked).toBe(2);
    });

    it("takes the project's own dependencies along with the root", async () => {
      const w = await standard();
      await w.write();
      await w.install({ workspace: { select: ['two'], includeRoot: true } });
      expect(await w.list('node_modules')).toEqual(
        expect.arrayContaining(['a', 'b', 'dd', 'left', 't', 'two']),
      );
      expect(await w.list('node_modules')).not.toContain('one');
    });

    it('is not an install at all when it names no member', async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'node_modules/keep'), { recursive: true });
      await expect(
        w.install({ workspace: { select: ['nobody'] } }),
      ).rejects.toMatchObject({
        code: 'INVALID_SPEC',
        message: expect.stringMatching(
          /No workspaces found: --workspace=nobody/u,
        ),
      });
      expect(await exists(join(w.dir, 'node_modules/keep'))).toBe(true);
    });

    it('applies --omit to what the member needs', async () => {
      const w = await standard();
      await w.write();
      await w.install({ omit: ['dev'], workspace: { select: ['two'] } });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['b', 'two']);
    });
  });

  describe('--workspaces', () => {
    it("installs every member and not the project's own dependencies", async () => {
      const w = await standard();
      await w.write();
      await w.install({ workspace: { all: true } });
      const names = await w.list('node_modules');
      expect(names).toEqual(expect.arrayContaining(['one', 'two', 'b', 'a']));
      // Named by the project alone, and by no member.
      expect(names).not.toContain('t');
      expect(names).not.toContain('left');
      expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
        'left@0.9.0',
      );
    });

    it("=false installs the project's own dependencies and links no member", async () => {
      const w = await standard();
      await w.write();
      const result = await w.install({ workspace: { ignore: true } });
      expect(result.workspace).toEqual({ members: 2, linked: 0 });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['a', 'left', 't']);
    });

    it('=false cannot be combined with a selection', async () => {
      const w = await standard();
      await w.write();
      await expect(
        w.install({ workspace: { ignore: true, select: ['one'] } }),
      ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    });
  });

  it("applies --omit=dev to a member's development dependencies", async () => {
    const w = await standard();
    await w.write();
    await w.install({ omit: ['dev'] });
    expect(await w.list('node_modules')).not.toContain('dd');
    expect(await w.list('node_modules')).not.toContain('t');
    expect(await w.list('node_modules')).toContain('two');
  });
});
