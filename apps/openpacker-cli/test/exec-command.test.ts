import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { parseExecRequest } from '../src/commands/run-args.js';
import { processContext, runExecCommand } from '../src/commands/run.js';
import {
  addFakeTool,
  capture,
  makeDirectory,
  makeProject,
  report,
} from './run-fixture.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');
const MARKER = 'vtok_dummy_marker_0123456789abcdef';

describe('opm exec: running a bin', () => {
  it('runs a bin from node_modules/.bin with the arguments after --', async () => {
    const root = await makeProject({ name: 'app', version: '2.0.0' });
    const cap = capture();
    expect(
      await runOpm(
        ['exec', 'fake-tool', '--', '--version', 'a b'],
        cap.io,
        root,
      ),
      cap.err,
    ).toBe(0);
    expect(report(cap.out)).toMatchObject({
      argv: ['--version', 'a b'],
      cwd: root,
      event: 'exec',
      name: 'app',
      version: '2.0.0',
    });
  });

  it('hands flags after the bin to it even without --', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(await runOpm(['exec', 'fake-tool', '--version'], cap.io, root)).toBe(
      0,
    );
    expect(report(cap.out).argv).toEqual(['--version']);
  });

  it('hands --help after the bin to the bin, not to opm', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(await runOpm(['exec', 'fake-tool', '--help'], cap.io, root)).toBe(0);
    expect(report(cap.out).argv).toEqual(['--help']);
    const own = capture();
    expect(await runOpm(['exec', '--help'], own.io, root)).toBe(0);
    expect(own.out).toContain('opm exec <bin>');
  });

  it('exits with the status of the bin', async () => {
    const root = await makeProject({});
    for (const code of [1, 5, 7, 200]) {
      const cap = capture();
      expect(
        await runOpm(
          ['exec', 'fake-tool', '--', '--exit', String(code)],
          cap.io,
          root,
        ),
      ).toBe(code);
      expect(cap.err).toBe('');
    }
  });

  it('runs in the directory it was started in, with the .bin directories of the project on PATH', async () => {
    const root = await makeProject({ opm: true });
    const sub = await makeDirectory(root, 'src');
    const cap = capture();
    expect(await runOpm(['exec', 'fake-tool'], cap.io, sub)).toBe(0);
    const seen = report(cap.out);
    expect(seen.cwd).toBe(sub);
    expect(seen.path[0]).toBe(join(root, 'node_modules', '.bin'));
  });

  it('finds a bin in a parent directory', async () => {
    const root = await makeProject({ opm: true });
    const sub = await makeDirectory(root, 'packages/app');
    const cap = capture();
    expect(await runOpm(['exec', 'fake-tool'], cap.io, sub)).toBe(0);
  });

  it('takes --path as the project exactly, and runs there', async () => {
    const root = await makeProject({});
    const other = await makeDirectory(root, 'other');
    await addFakeTool(join(other, 'node_modules'));
    const cap = capture();
    expect(
      await runOpm(['exec', '--path', 'other', 'fake-tool'], cap.io, root),
      cap.err,
    ).toBe(0);
    expect(report(cap.out).cwd).toBe(other);
  });

  it.skipIf(process.platform === 'win32')(
    'exits 128 plus the signal number when a signal ends the bin',
    async () => {
      const root = await makeProject({});
      await addFakeTool(join(root, 'node_modules'));
      const shim = join(root, 'node_modules', '.bin', 'die');
      await writeFile(shim, '#!/bin/sh\nkill -TERM $$\nsleep 5\n', {
        mode: 0o755,
      });
      const cap = capture();
      expect(await runOpm(['exec', 'die'], cap.io, root)).toBe(143);
      expect(cap.err).toBe('opm: "die" was ended by SIGTERM\n');
    },
  );
});

describe('opm exec: a program that cannot start', () => {
  it.skipIf(process.platform === 'win32')(
    'exits 8 and names the command, not the environment',
    async () => {
      const root = await makeProject({});
      await writeFile(
        join(root, 'node_modules', '.bin', 'broken'),
        '#!/no/such/interpreter\n',
        { mode: 0o755 },
      );
      const cap = capture();
      expect(await runOpm(['exec', 'broken'], cap.io, root)).toBe(8);
      expect(cap.err).toContain('Cannot start "broken"');
    },
  );
});

describe('opm exec: what it refuses', () => {
  it('never searches PATH, so a program that is not in .bin is not found', async () => {
    const root = await makeProject({});
    const cap = capture();
    // `node` is the one name exec answers itself (ADR 0053), so it cannot
    // stand for "a program on PATH"; `sh` is on every PATH that matters here.
    const program = process.platform === 'win32' ? 'cmd' : 'sh';
    expect(await runOpm(['exec', program, '--version'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('exec never fetches or searches PATH');
    expect(cap.out).toBe('');
  });

  it.each(['./fake-tool', '/bin/sh', '../x', 'a\\b', '.', '..'])(
    'refuses %j, which is a path and not a bin name',
    async (bin) => {
      const root = await makeProject({});
      const cap = capture();
      expect(await runOpm(['exec', bin], cap.io, root)).toBe(2);
      expect(cap.err).toContain(`Cannot exec "${bin}"`);
    },
  );

  it('asks for a bin, and refuses an option of its own it does not know', async () => {
    const root = await makeProject({});
    for (const argv of [['exec'], ['exec', '--watch', 'fake-tool']]) {
      const cap = capture();
      expect(await runOpm(argv, cap.io, root)).toBe(2);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'says a bin exists but cannot be executed',
    async () => {
      const root = await makeProject({});
      await writeFile(
        join(root, 'node_modules', '.bin', 'inert'),
        '#!/bin/sh\n',
        {
          mode: 0o644,
        },
      );
      const cap = capture();
      expect(await runOpm(['exec', 'inert'], cap.io, root)).toBe(4);
      expect(cap.err).toContain('inert exists but is not executable');
    },
  );
});

describe('opm exec: a bin that is not there', () => {
  it('says there is no opm project to ask when there is none', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(await runOpm(['exec', 'tsc'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('not an opm project');
  });

  it('says no locked package provides it', async () => {
    const root = await makeProject({ opm: true });
    await writeFile(
      join(root, 'opm.lock.json'),
      JSON.stringify({ schemaVersion: 1, generatedBy: 'opm', packages: {} }),
    );
    const cap = capture();
    expect(await runOpm(['exec', 'tsc'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('No package in opm.lock.json provides "tsc"');
  });

  it('never prints the environment', async () => {
    const root = await makeProject({});
    const cap = capture();
    const context = {
      ...processContext(),
      env: { PATH: process.env.PATH ?? '', OPM_TEST_SECRET: MARKER },
    };
    await runExecCommand(
      parseExecRequest([], ['fake-tool', '--exit', '3']),
      cap.io,
      root,
      context,
    );
    await runExecCommand(
      parseExecRequest([], ['absent']),
      cap.io,
      root,
      context,
    ).catch((error: unknown) => cap.io.stderr.write(String(error)));
    expect(cap.out + cap.err).not.toContain(MARKER);
  });
});

describe('opm exec: against a real layout, offline', () => {
  /** An opm project with the fixture package locked and, optionally, laid out. */
  async function lockedProject(layout: boolean): Promise<string> {
    const root = await makeProject({ noPackage: true });
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    expect(
      await runOpm(
        ['init', '--name', 'exec-demo', '--force'],
        capture().io,
        root,
      ),
    ).toBe(0);
    await mkdir(join(root, '.opm'), { recursive: true });
    // SAFETY: The fixture catalog has this shape.
    const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
      packages: Record<string, { source: string }>;
    };
    for (const entry of Object.values(catalog.packages))
      entry.source = `file:${fixtureTgz}`;
    await writeFile(join(root, '.opm/catalog.json'), JSON.stringify(catalog));
    if (layout)
      await writeFile(
        join(root, 'opm.toml'),
        (await readFile(join(root, 'opm.toml'), 'utf8')).replace(
          'layout = "opm"',
          'layout = "opm"\nnative_projection = "layout"',
        ),
      );
    const cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
        cap.io,
        root,
      ),
      cap.err,
    ).toBe(0);
    return root;
  }

  it(
    'runs the bin the layout wrote, with no network',
    { timeout: 30_000 },
    async () => {
      const root = await lockedProject(true);
      const cap = capture();
      expect(
        await runOpm(['exec', 'demo-tool', '--', '--version'], cap.io, root),
        cap.err,
      ).toBe(0);
      expect(cap.out).toMatch(/1\.1\.0/u);
    },
  );

  it(
    'names the locked package that would provide a bin the layout has not written',
    { timeout: 30_000 },
    async () => {
      const root = await lockedProject(false);
      const cap = capture();
      expect(await runOpm(['exec', 'demo-tool'], cap.io, root)).toBe(4);
      expect(cap.err).toContain(
        'demo-tool (pkg:npm/%40openpacker/demo-tool@1.1.0), a direct requirement, declares it',
      );
      expect(cap.err).toContain('native_projection = "layout"');
      expect(cap.err).toContain('opmx demo-tool');
      expect(cap.out).toBe('');
    },
  );

  it(
    'says to sync when the layout is asked for and the bin is still missing',
    { timeout: 30_000 },
    async () => {
      const root = await lockedProject(true);
      await rm(join(root, 'node_modules'), { recursive: true, force: true });
      const cap = capture();
      expect(await runOpm(['exec', 'demo-tool'], cap.io, root)).toBe(4);
      expect(cap.err).toContain('Run: opm sync');
      expect(cap.err).not.toContain('Set native_projection');
      expect(await runOpm(['sync', '--offline'], capture().io, root)).toBe(0);
      expect(
        await runOpm(
          ['exec', 'demo-tool', '--', '--version'],
          capture().io,
          root,
        ),
      ).toBe(0);
    },
  );
});
