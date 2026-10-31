import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runOpm } from '../src/opm.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
// The commands a test started and has not seen end. A test that times out
// leaves its command running in the project; removing the project under it
// fails (ENOTEMPTY) and buries the timeout under a second error. Cleanup waits
// for every command first.
const running = new Set<Promise<number>>();
function opm(...args: Parameters<typeof runOpm>): Promise<number> {
  const command = runOpm(...args);
  running.add(command);
  const done = () => running.delete(command);
  command.then(done, done);
  return command;
}
afterEach(async () => {
  await Promise.allSettled(running);
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

async function writeCatalog(
  root: string,
  versions: readonly { name: string; version: string }[],
): Promise<void> {
  const bytes = await readFile(fixtureTgz);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const packages: Record<string, unknown> = {};
  for (const { name, version } of versions) {
    const purl = `pkg:npm/${name}@${version}`;
    packages[purl] = {
      purl,
      version,
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
      source: `file:${fixtureTgz}`,
      bins: [{ name, path: 'package/bin/demo-tool.js' }],
    };
  }
  await mkdir(join(root, '.opm'), { recursive: true });
  await writeFile(
    join(root, '.opm/catalog.json'),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
}

describe('opm update CLI', () => {
  it('documents alias selection and --latest', async () => {
    const cap = capture();
    expect(await opm(['help'], cap.io)).toBe(0);
    expect(cap.out).toContain(
      'opm update [alias...] [--latest] [--offline|--online]',
    );
    expect(cap.out).not.toMatch(/opm update \[--offline\|--online\]$/m);
  });

  it('prints Updated and never Synced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-update-'));
    temps.push(root);
    let cap = capture();
    expect(await opm(['init', '--name', 'cli-update'], cap.io, root)).toBe(0);
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    cap = capture();
    expect(
      await opm(['add', 'pkg:npm/alpha@1.0.0', '--offline'], cap.io, root),
    ).toBe(0);

    const toml = await readFile(join(root, 'opm.toml'), 'utf8');
    await writeFile(
      join(root, 'opm.toml'),
      toml.replace('version = "1.0.0"', 'version = "^1.0.0"'),
    );

    cap = capture();
    expect(await opm(['update', '--offline'], cap.io, root)).toBe(0);
    expect(cap.out).toContain('Updated 1 package(s): alpha');
    expect(cap.out).not.toContain('Synced');

    cap = capture();
    expect(await opm(['update', '--offline'], cap.io, root)).toBe(0);
    expect(cap.out).toContain('Already up to date');
    expect(cap.out).not.toContain('Synced');
  });
});
