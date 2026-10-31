import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { NpmProjectFormat } from './project.js';
import { LAYOUT_RECORD } from './layout-write.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Pkg {
  files?: Record<string, string>;
  bin?: string | Record<string, string>;
  direct?: boolean;
  requires?: string[];
  alias?: string;
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'npm-layout-'));
  temps.push(dir);
  const project = join(dir, 'project');
  await mkdir(project, { recursive: true });
  let counter = 0;
  return {
    dir,
    project,
    /** An extracted npm tarball in a content-addressed store directory. */
    async store(id: string, spec: Pkg = {}): Promise<NativeLockEntry> {
      const at = id.lastIndexOf('@');
      const name = id.slice(0, at);
      const version = id.slice(at + 1);
      counter += 1;
      const storePath = join(dir, 'store', `sha256-${counter}`);
      const files: Record<string, string> = {
        'package.json': JSON.stringify({
          name,
          version,
          main: 'index.js',
          ...(spec.bin !== undefined && { bin: spec.bin }),
        }),
        'index.js': `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`,
        ...spec.files,
      };
      for (const [path, contents] of Object.entries(files)) {
        const target = join(storePath, 'package', path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents, { mode: 0o644 });
      }
      return {
        purl: `pkg:npm/${name}`,
        exactPurl: `pkg:npm/${name}@${version}`,
        name,
        version,
        scope: 'runtime',
        source: `file:${storePath}`,
        digest: `sha256:${String(counter).padStart(64, '0')}`,
        size: 1,
        storePath,
        transitive: spec.direct !== true,
        alias: spec.alias ?? id,
        ...(spec.requires !== undefined && { dependencies: spec.requires }),
      };
    },
    async layout(entries: NativeLockEntry[]) {
      const format = new NpmProjectFormat();
      const detected = await format.detectLayout(project);
      if (!detected) throw new Error('layout target missing');
      return format.writeLayout(detected, entries);
    },
    run(script: string, cwd = project): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd,
        encoding: 'utf8',
      }).trim();
    },
  };
}

async function walk(root: string, at = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    out.push(path);
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
  }
  return out;
}

describe('NpmProjectFormat.writeLayout', () => {
  it('lets real Node resolve two versions of one package from different dependents', async () => {
    const w = await workspace();
    const entries = [
      await w.store('a@1.0.0', {
        direct: true,
        requires: ['c@1.0.0'],
        files: {
          'index.js': "module.exports = { c: require('c').version };\n",
        },
      }),
      await w.store('b@1.0.0', {
        direct: true,
        requires: ['c@2.0.0'],
        files: {
          'index.js': "module.exports = { c: require('c').version };\n",
        },
      }),
      await w.store('c@1.0.0'),
      await w.store('c@2.0.0'),
    ];

    await w.layout(entries);

    expect(
      w.run(
        "console.log(JSON.stringify([require('a').c, require('b').c, require('c').version]))",
      ),
    ).toBe('["1.0.0","2.0.0","2.0.0"]');
  });

  it('keeps a nested dependency tree correct when the root holds another version', async () => {
    const w = await workspace();
    const reads = "module.exports = { c: require('c').version };\n";
    const entries = [
      await w.store('c@1.0.0', { direct: true }),
      await w.store('b@1.0.0', {
        direct: true,
        requires: ['c@2.0.0', 'x@1.0.0'],
        files: {
          'index.js':
            "module.exports = { c: require('c').version, x: require('x').c };\n",
        },
      }),
      await w.store('x@1.0.0', {
        requires: ['c@2.0.0'],
        files: { 'index.js': reads },
      }),
      await w.store('c@2.0.0'),
    ];

    await w.layout(entries);

    expect(w.run("console.log(JSON.stringify(require('b')))")).toBe(
      '{"c":"2.0.0","x":"2.0.0"}',
    );
    expect(w.run("console.log(require('c').version)")).toBe('1.0.0');
  });

  it('hard-links the store files and creates no symlink anywhere', async () => {
    const w = await workspace();
    const entry = await w.store('a@1.0.0', { direct: true });

    const result = await w.layout([entry]);

    const stored = await stat(join(entry.storePath!, 'package', 'index.js'));
    const installed = await stat(
      join(w.project, 'node_modules', 'a', 'index.js'),
    );
    expect(installed.ino).toBe(stored.ino);
    expect(installed.nlink).toBe(2);
    for (const path of await walk(join(w.project, 'node_modules')))
      expect(
        (await lstat(join(w.project, 'node_modules', path))).isSymbolicLink(),
      ).toBe(false);
    expect(result.semanticLoss[0]?.representedMeaning).toMatch(/hardlinked/u);
    expect(result.written).toEqual([join(w.project, 'node_modules')]);
  });

  it('writes bins as script shims that run from node_modules/.bin without symlinks', async () => {
    const w = await workspace();
    const entries = [
      await w.store('tool@1.0.0', {
        direct: true,
        bin: { tool: 'bin/tool.js', 'tool-alias': './bin/tool.js' },
        files: {
          'bin/tool.js':
            '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
        },
      }),
      await w.store('@scope/cli@2.0.0', {
        direct: true,
        bin: 'cli.js',
        files: {
          'cli.js':
            "#!/usr/bin/env node\nconsole.log('scoped', require('./package.json').version);\n",
        },
      }),
    ];

    await w.layout(entries);

    const bin = join(w.project, 'node_modules', '.bin');
    const info = await lstat(join(bin, 'tool'));
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o111).not.toBe(0);
    expect(
      execFileSync(join(bin, 'tool'), ['x', 'two words'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('["x","two words"]');
    expect(
      execFileSync(join(bin, 'tool-alias'), { encoding: 'utf8' }).trim(),
    ).toBe('[]');
    expect(execFileSync(join(bin, 'cli'), { encoding: 'utf8' }).trim()).toBe(
      'scoped 2.0.0',
    );
    // Found through PATH the way a script run by a package manager finds it.
    expect(
      execFileSync('sh', ['-c', 'tool a'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }).trim(),
    ).toBe('["a"]');
    expect(await readFile(join(bin, 'tool'), 'utf8')).toContain(
      "'/../tool/bin/tool.js'",
    );
  });

  // npm links `.bin/<name>` to the script, so `node node_modules/.bin/tsc` runs
  // tsc; a project's scripts and its people do exactly that. The shim is no
  // link, so it has to be a program node runs as well as one sh runs.
  it.each([
    ['a CommonJS project', undefined],
    ['an ES module project', 'module'],
  ])(
    'runs a node bin when node is handed the shim, in %s',
    async (_label, type) => {
      const w = await workspace();
      if (type !== undefined)
        await writeFile(
          join(w.project, 'package.json'),
          JSON.stringify({ name: 'p', type }),
        );
      const entries = [
        await w.store('cjs-tool@1.0.0', {
          direct: true,
          bin: { 'cjs-tool': 'bin/cli.js' },
          files: {
            'bin/cli.js': [
              '#!/usr/bin/env node',
              "const { realpathSync } = require('node:fs');",
              'console.log(JSON.stringify({',
              '  main: require.main === module,',
              '  argv1: realpathSync(process.argv[1]) === __filename,',
              '  args: process.argv.slice(2),',
              '}));',
              '',
            ].join('\n'),
          },
        }),
        await w.store('esm-tool@1.0.0', {
          direct: true,
          bin: { 'esm-tool': 'cli.mjs' },
          files: {
            'cli.mjs': [
              '#!/usr/bin/env node',
              "import { realpathSync } from 'node:fs';",
              "import { pathToFileURL } from 'node:url';",
              'const main = pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;',
              'console.log(JSON.stringify({ main, args: process.argv.slice(2) }));',
              '',
            ].join('\n'),
          },
        }),
        await w.store('fails@1.0.0', {
          direct: true,
          bin: { fails: 'cli.js' },
          files: { 'cli.js': 'process.exitCode = 3;\n' },
        }),
      ];

      await w.layout(entries);

      const bin = join(w.project, 'node_modules', '.bin');
      const viaNode = (name: string, args: string[] = []) =>
        JSON.parse(
          execFileSync(process.execPath, [join(bin, name), ...args], {
            cwd: w.project,
            encoding: 'utf8',
          }),
        ) as unknown;
      expect(viaNode('cjs-tool', ['x', 'two words'])).toEqual({
        main: true,
        argv1: true,
        args: ['x', 'two words'],
      });
      expect(viaNode('esm-tool', ['--flag'])).toEqual({
        main: true,
        args: ['--flag'],
      });
      expect(() =>
        execFileSync(process.execPath, [join(bin, 'fails')], {
          cwd: w.project,
          stdio: 'pipe',
        }),
      ).toThrow(expect.objectContaining({ status: 3 }));
      // And it is still the shell program it was.
      expect(
        JSON.parse(
          execFileSync(join(bin, 'cjs-tool'), ['y'], { encoding: 'utf8' }),
        ),
      ).toEqual({ main: true, argv1: true, args: ['y'] });
    },
  );

  it('honours the interpreter in a shebang and ignores one it cannot trust', async () => {
    const w = await workspace();
    const entries = [
      await w.store('sh-tool@1.0.0', {
        direct: true,
        bin: 'run.sh',
        files: { 'run.sh': '#!/bin/sh\necho "from sh $1"\n' },
      }),
      await w.store('odd@1.0.0', {
        direct: true,
        bin: 'odd.js',
        files: {
          'odd.js': "#!/usr/bin/env $(touch pwned)\nconsole.log('node ran');\n",
        },
      }),
    ];

    await w.layout(entries);

    const bin = join(w.project, 'node_modules', '.bin');
    expect(
      execFileSync(join(bin, 'sh-tool'), ['arg'], { encoding: 'utf8' }).trim(),
    ).toBe('from sh arg');
    expect(
      execFileSync(join(bin, 'odd'), { encoding: 'utf8', cwd: w.dir }).trim(),
    ).toBe('node ran');
    await expect(lstat(join(w.dir, 'pwned'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a bin whose target leaves the package or whose name is not a file name', async () => {
    const w = await workspace();
    const entry = await w.store('evil@1.0.0', {
      direct: true,
      bin: {
        ok: 'ok.js',
        escape: '../../../../etc/passwd',
        absolute: '/etc/passwd',
        '../../hijack': 'ok.js',
        quote: "ok.js'; touch pwned; '",
        missing: 'nope.js',
      },
      files: { 'ok.js': 'console.log(1)\n' },
    });

    const result = await w.layout([entry]);

    expect(await readdir(join(w.project, 'node_modules', '.bin'))).toEqual([
      'ok',
    ]);
    const reasons = (result.skipped ?? [])
      .map((item) => item.reason)
      .join('\n');
    for (const name of [
      'escape',
      'absolute',
      '../../hijack',
      'quote',
      'missing',
    ])
      expect(reasons).toContain(`bin ${JSON.stringify(name)}`);
    expect(result.skipped).toHaveLength(5);
    // Nothing was written outside node_modules for the refused names.
    expect(await readdir(w.project)).toEqual(['node_modules']);
  });

  it('gives a contested bin name to the direct requirement and says who lost', async () => {
    const w = await workspace();
    const entries = [
      await w.store('zeta@1.0.0', {
        direct: true,
        bin: { tsc: 'cli.js' },
        files: { 'cli.js': "console.log('zeta')\n" },
      }),
      await w.store('alpha@1.0.0', {
        bin: { tsc: 'cli.js' },
        files: { 'cli.js': "console.log('alpha')\n" },
      }),
    ];

    const result = await w.layout(entries);

    expect(
      execFileSync(join(w.project, 'node_modules', '.bin', 'tsc'), {
        encoding: 'utf8',
      }).trim(),
    ).toBe('zeta');
    expect(result.skipped?.map((item) => item.reason).join('\n')).toMatch(
      /alpha also declares tsc; zeta keeps it/u,
    );
  });

  it('writes the bins of a nested package next to it', async () => {
    const w = await workspace();
    const entries = [
      await w.store('c@1.0.0', { direct: true }),
      await w.store('b@1.0.0', { direct: true, requires: ['tool@1.0.0'] }),
      await w.store('tool@1.0.0', {
        bin: 'cli.js',
        files: { 'cli.js': "console.log('nested tool')\n" },
      }),
      await w.store('c@2.0.0', {
        bin: { c2: 'cli.js' },
        files: { 'cli.js': "console.log('c2')\n" },
      }),
    ];
    entries[1]!.dependencies = ['c@2.0.0', 'tool@1.0.0'];

    await w.layout(entries);

    expect(
      execFileSync(
        join(w.project, 'node_modules', 'b', 'node_modules', '.bin', 'c2'),
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('c2');
    expect(
      execFileSync(join(w.project, 'node_modules', '.bin', 'tool'), {
        encoding: 'utf8',
      }).trim(),
    ).toBe('nested tool');
  });

  it('removes what an earlier layout wrote and leaves what it did not', async () => {
    const w = await workspace();
    const first = [
      await w.store('keep@1.0.0', { direct: true }),
      await w.store('drop@1.0.0', {
        direct: true,
        bin: 'cli.js',
        files: { 'cli.js': '1\n' },
      }),
      await w.store('@s/gone@1.0.0', { direct: true }),
    ];
    await w.layout(first);
    const foreign = join(w.project, 'node_modules', 'by-hand');
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'package.json'), '{"name":"by-hand"}');

    await w.layout([first[0]!]);

    const names = await readdir(join(w.project, 'node_modules'));
    expect(names.sort()).toEqual(
      ['.bin', LAYOUT_RECORD, 'by-hand', 'keep'].sort(),
    );
    expect(await readdir(join(w.project, 'node_modules', '.bin'))).toEqual([]);
    expect(
      JSON.parse(
        await readFile(join(w.project, 'node_modules', LAYOUT_RECORD), 'utf8'),
      ),
    ).toEqual({ layoutVersion: 1, packages: ['keep'], bins: [] });
  });

  it('does not let a hand-edited record turn into a path outside node_modules', async () => {
    const w = await workspace();
    await w.layout([await w.store('keep@1.0.0', { direct: true })]);
    const victim = join(w.dir, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'precious'), 'x');
    await writeFile(
      join(w.project, 'node_modules', LAYOUT_RECORD),
      JSON.stringify({
        layoutVersion: 1,
        packages: ['../../victim', '.bin', 'keep-not'],
        bins: ['../victim'],
      }),
    );

    await w.layout([await w.store('keep@1.0.0', { direct: true })]);

    expect(await readFile(join(victim, 'precious'), 'utf8')).toBe('x');
  });

  it('reports a package that is not in the store instead of writing half of it', async () => {
    const w = await workspace();
    const present = await w.store('here@1.0.0', { direct: true });
    const absent = { ...(await w.store('gone@1.0.0', { direct: true })) };
    delete absent.storePath;

    const result = await w.layout([present, absent]);

    expect(result.skipped?.[0]?.reason).toMatch(/not materialised/u);
    expect(await readdir(join(w.project, 'node_modules'))).toContain('here');
    expect(await readdir(join(w.project, 'node_modules'))).not.toContain(
      'gone',
    );
  });

  it('writes the layout of a directory with no package.json and creates none', async () => {
    const w = await workspace();
    const format = new NpmProjectFormat();
    expect(await format.detect(w.project)).toBeUndefined();

    await w.layout([await w.store('a@1.0.0', { direct: true })]);

    expect(await readdir(w.project)).toEqual(['node_modules']);
  });

  it('replaces a package rather than merging it into the previous resolution', async () => {
    const w = await workspace();
    const entry = await w.store('a@1.0.0', { direct: true });
    await w.layout([entry]);
    await writeFile(join(w.project, 'node_modules', 'a', 'stale.txt'), 'old');

    await w.layout([entry]);

    await expect(
      lstat(join(w.project, 'node_modules', 'a', 'stale.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the store inode untouched when the project tree is deleted', async () => {
    const w = await workspace();
    const entry = await w.store('a@1.0.0', { direct: true });
    await w.layout([entry]);

    await rm(join(w.project, 'node_modules'), { recursive: true });

    const stored = join(entry.storePath!, 'package', 'index.js');
    expect((await stat(stored)).nlink).toBe(1);
    expect(await readFile(stored, 'utf8')).toContain('"a"');
  });
});
