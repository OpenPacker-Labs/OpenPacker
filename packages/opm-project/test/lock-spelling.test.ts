import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  parseLockfile,
  readLockfile,
  readManifestFile,
  syncProject,
  whyPackage,
} from '../src/index.js';
import { assertLockMatchesManifest } from '../src/project.js';

configureDefaultAdapters();

/**
 * One spelling of one identity in a lock. An npm scope typed `@` and one typed
 * `%40` are one package, but a catalog (offline) add kept the typed `@` in the
 * lock while a registry add wrote `%40`: the same project could lock two
 * spellings of one package, and comparisons between locks saw two. Every PURL a
 * lock is read with or written with is now the encoded one; opm.toml keeps what
 * was typed, and is compared with the lock canonically.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');
const LITERAL = 'pkg:npm/@openpacker/demo-tool@1.1.0';
const ENCODED = 'pkg:npm/%40openpacker/demo-tool@1.1.0';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A project whose catalog serves demo-tool from the repository's fixture. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-lock-spelling-'));
  roots.push(root);
  await initProject({ root, name: 'spelling' });
  await mkdir(join(root, '.opm'), { recursive: true });
  // SAFETY: the repository's own fixture catalog.
  const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
    packages: Record<string, { source: string }>;
  };
  delete catalog.packages[LITERAL];
  for (const entry of Object.values(catalog.packages))
    entry.source = `file:${fixtureTgz}`;
  await writeFile(
    join(root, '.opm/catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  return root;
}

const read = (root: string, name: string) => readFile(join(root, name), 'utf8');

/** What `opm install` checks first: that the lock is the lock of opm.toml. */
const bound = async (root: string) =>
  assertLockMatchesManifest(
    root,
    await readManifestFile(join(root, 'opm.toml')),
    (await readLockfile(join(root, 'opm.lock.json')))!,
  );

describe('a catalog add typed with @', () => {
  it('locks the encoded spelling and keeps the typed one in opm.toml', async () => {
    const root = await project();
    const added = await addPackage({ root, spec: LITERAL, offline: true });
    expect(added.lock.packages['demo-tool']?.purl).toBe(ENCODED);
    expect(added.state.packages['demo-tool']?.purl).toBe(ENCODED);
    const lock = await read(root, 'opm.lock.json');
    expect(lock).toContain(`"purl": "${ENCODED}"`);
    expect(lock).not.toContain('pkg:npm/@');
    expect(await read(root, 'opm.toml')).toContain(
      'purl = "pkg:npm/@openpacker/demo-tool"',
    );
    // opm.toml and the lock are compared canonically: the lock is its lock.
    await expect(bound(root)).resolves.toBeUndefined();
  });

  it('locks what the encoded spelling locks', async () => {
    const literal = await project();
    const encoded = await project();
    await addPackage({ root: literal, spec: LITERAL, offline: true });
    await addPackage({ root: encoded, spec: ENCODED, offline: true });
    // Only the digest of opm.toml, which keeps what was typed, differs.
    const packagesOf = async (root: string) =>
      parseLockfile(await read(root, 'opm.lock.json')).packages;
    expect(await packagesOf(literal)).toEqual(await packagesOf(encoded));
  });
});

describe('a lock written before, with the @ spelling', () => {
  const legacy = async () => {
    const root = await project();
    await addPackage({ root, spec: LITERAL, offline: true });
    const lockPath = join(root, 'opm.lock.json');
    // What this build's predecessor wrote for the same add.
    await writeFile(
      lockPath,
      (await readFile(lockPath, 'utf8')).replaceAll(ENCODED, LITERAL),
    );
    expect(await read(root, 'opm.lock.json')).toContain(LITERAL);
    return root;
  };

  it('still reads, as the encoded spelling', async () => {
    const root = await legacy();
    const lock = parseLockfile(await read(root, 'opm.lock.json'));
    expect(lock.packages['demo-tool']?.purl).toBe(ENCODED);
    await expect(bound(root)).resolves.toBeUndefined();
    expect(await whyPackage(root, ENCODED)).toContain(`locked: ${ENCODED}`);
  });

  it('is rewritten canonically on the next write', async () => {
    const root = await legacy();
    await syncProject({ root, offline: true });
    const lock = await read(root, 'opm.lock.json');
    expect(lock).toContain(`"purl": "${ENCODED}"`);
    expect(lock).not.toContain('pkg:npm/@');
  });
});
