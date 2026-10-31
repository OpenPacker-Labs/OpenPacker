/**
 * An approved install script that calls `npm run` (ADR 0060, ADR 0061) gets
 * opm's npm inside the jail, as a script under `opm run` does: its own
 * package's script runs through `opm run`, npm's other commands are refused,
 * and the shim is read-only to the script. The shims start `dist/shims/*.js`:
 * run `npm run build -w @openpacker/opm` first.
 */
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jailShims, packageShims } from '../src/commands/run-shims.js';
import { EXIT_CODES, runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';
import { jailed, scriptedProject } from './ci-scripts-fixture.js';

const record = (file: string, value: string) =>
  `node -e "require('fs').writeFileSync('${file}', process.argv[1])" -- "${value}"`;

describe.skipIf(!jailed)('npm inside an approved install script', () => {
  it("runs the package's own script through opm run, in the jail", async () => {
    const p = await scriptedProject(
      [
        {
          name: 'native',
          scripts: {
            postinstall: 'npm run build -- --release',
            prebuild: record('pre.txt', '$npm_lifecycle_event'),
            build: `${record('built.txt', '$npm_package_name $npm_execpath')} && ${record('args.txt', '$*')}`,
          },
        },
      ],
      ['native'],
      { trustedDependencies: ['native'] },
    );
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(c.err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    const dir = join(p.dir, 'node_modules', 'native');
    expect(await readFile(join(dir, 'pre.txt'), 'utf8')).toBe('prebuild');
    expect(await readFile(join(dir, 'built.txt'), 'utf8')).toBe(
      `native ${packageShims().npmExecpath}`,
    );
    expect(await readFile(join(dir, 'args.txt'), 'utf8')).toBe('--release');
  });

  it('refuses npm install in the script, and the install fails saying so', async () => {
    const p = await scriptedProject(
      [{ name: 'fetches', scripts: { postinstall: 'npm install left-pad' } }],
      ['fetches'],
      { pnpm: { onlyBuiltDependencies: ['fetches'] } },
    );
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(code).not.toBe(EXIT_CODES.success);
    expect(c.err).toContain('npm install inside opm run');
    expect(c.err).toContain('opm ci');
  });

  it('cannot write the shim it finds on PATH', async () => {
    const p = await scriptedProject(
      [
        {
          name: 'meddles',
          scripts: {
            postinstall: [
              `${record('found.txt', '$(command -v npm)')}`,
              'if (echo hijacked > "$(command -v npm)") 2>/dev/null; then echo writable > tried.txt; else echo refused > tried.txt; fi',
            ].join(' && '),
          },
        },
      ],
      ['meddles'],
      { trustedDependencies: ['meddles'] },
    );
    const shim = join(packageShims().bin, 'npm');
    const before = await readFile(shim, 'utf8');
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(c.err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    const dir = join(p.dir, 'node_modules', 'meddles');
    expect(await readFile(join(dir, 'found.txt'), 'utf8')).toBe(shim);
    expect((await readFile(join(dir, 'tried.txt'), 'utf8')).trim()).toBe(
      'refused',
    );
    expect(await readFile(shim, 'utf8')).toBe(before);
  });
});

describe('what the jail mounts for the shims', () => {
  it('mounts real paths only: the opm package, and canonical where Node finds it from there', async () => {
    const shims = await jailShims();
    for (const path of shims.readonlyPaths)
      expect(await realpath(path)).toBe(path);
    const [own] = shims.readonlyPaths;
    expect(shims.bin).toBe(join(own!, 'shims', 'bin'));
    expect(shims.env).toEqual({
      npm_execpath: join(own!, 'dist', 'shims', 'npm.js'),
      npm_node_execpath: process.execPath,
    });
    // What `opm run` loads to word a failure is under one of them.
    const canonical = await realpath(
      createRequire(join(own!, 'dist', 'commands', 'run.js')).resolve(
        '@openpacker/canonical',
      ),
    );
    expect(
      shims.readonlyPaths.some((path) => canonical.startsWith(`${path}/`)),
    ).toBe(true);
  });
});
