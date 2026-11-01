import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runOpm } from '../src/opm.js';

/**
 * What the CLI says about a package installed under another name (ADR 0054):
 * `add` names the install name, `list` shows the names an entry is installed
 * as, and `why` says which dependent asked for it under which name.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
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

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-cli-alias-'));
  temps.push(root);
  expect(
    await runOpm(['init', '--name', 'cli-alias'], capture().io, root),
  ).toBe(0);
  const bytes = await readFile(fixtureTgz);
  const purl = 'pkg:npm/@openpacker/demo-tool@1.1.0';
  await mkdir(join(root, '.opm'), { recursive: true });
  await writeFile(
    join(root, '.opm/catalog.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packages: {
          [purl]: {
            purl,
            version: '1.1.0',
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            size: bytes.byteLength,
            format: 'tar+gzip',
            mediaType: 'application/vnd.npm.package+gzip',
            source: `file:${fixtureTgz}`,
            bins: [{ name: 'demo-tool', path: 'package/bin/demo-tool.js' }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe('opm add under another name', () => {
  it('says the name it was installed as', async () => {
    const root = await project();
    const cap = capture();
    const exit = await runOpm(
      ['add', 'demo-old@npm:@openpacker/demo-tool@1.1.0', '--offline'],
      cap.io,
      root,
    );
    expect(exit, cap.err).toBe(0);
    expect(cap.out).toContain(
      'Added demo-old → pkg:npm/%40openpacker/demo-tool@1.1.0 (installed as demo-old)',
    );
  });

  it('says nothing of a name when the package is installed as itself', async () => {
    const root = await project();
    const cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(0);
    expect(cap.out).not.toContain('installed as');
  });

  it('lists the install name beside the package, and why names it', async () => {
    const root = await project();
    expect(
      await runOpm(
        ['add', 'demo-old@npm:@openpacker/demo-tool@1.1.0', '--offline'],
        capture().io,
        root,
      ),
    ).toBe(0);
    const listed = capture();
    expect(await runOpm(['list', '--offline'], listed.io, root)).toBe(0);
    expect(listed.out).toMatch(/^demo-old\t.*\tinstalled .*as=\[demo-old\]$/mu);
    const why = capture();
    expect(await runOpm(['why', 'demo-old'], why.io, root)).toBe(0);
    expect(why.out).toContain('installed as: demo-old');
  });
});
