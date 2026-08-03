import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { runOpmx } from '../src/opmx.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('opm + opmx CLI', () => {
  it('init add install list opmx remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-'));
    temps.push(root);

    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);

    // local catalog with absolute file source
    await mkdir(join(root, '.opm'), { recursive: true });
    const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
      packages: Record<string, { source: string }>;
    };
    for (const entry of Object.values(catalog.packages)) {
      entry.source = `file:${fixtureTgz}`;
    }
    await writeFile(
      join(root, '.opm/catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
    );

    cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(0);
    expect(cap.out).toMatch(/Added demo-tool/);

    cap = capture();
    expect(await runOpm(['list'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/demo-tool/);
    expect(cap.out).toMatch(/installed/);

    cap = capture();
    expect(await runOpmx(['demo-tool', '--version'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/1\.1\.0/);

    cap = capture();
    expect(await runOpmx(['demo-tool', 'hello'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/demo-tool ok hello/);

    cap = capture();
    expect(await runOpm(['sync', '--offline'], cap.io, root)).toBe(0);

    cap = capture();
    expect(await runOpm(['remove', 'demo-tool'], cap.io, root)).toBe(0);

    cap = capture();
    expect(await runOpmx(['demo-tool'], cap.io, root)).toBe(4);
    expect(cap.err).toMatch(/No packages installed/);
  });

  it('exits 8 on an offline add with a network source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-offline-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);
    cap = capture();
    expect(
      await runOpm(
        [
          'add',
          'pkg:npm/@openpacker/demo-tool@1.1.0',
          '--source',
          'https://registry.example.invalid/demo.tgz',
          '--offline',
        ],
        cap.io,
        root,
      ),
    ).toBe(8);
    expect(cap.err).toMatch(/offline/i);
  });

  it('exits 5 when nothing can resolve a spec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-unres-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);
    cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/not-in-any-catalog@9.9.9', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(5);
    expect(cap.err).toMatch(/Cannot resolve/);
  });
});
