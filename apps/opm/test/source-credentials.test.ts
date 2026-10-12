import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * A source a person gives to `opm add --source`, or writes as `source` in
 * `opm.toml`, is theirs to write and not a lock's, but opm repeats it in a
 * refusal and the refusal goes to a terminal, a CI log and a bug report. A URL
 * with userinfo or a token in its query is shown as the other errors show a URL
 * (`redactAddress`): the scheme, the host and the path.
 *
 * A source that is not read over the network is read as a file, and opm named
 * the file it had made of the text (`/cwd/git+https:/user:<token>@host/...`),
 * and `opm why` named the source as written: both are shown as a URL is.
 */

const CANARY = 'vtok_dummy_marker_0123456789abcdef';
const SOURCE = `https://user:${CANARY}@host.example/x.tgz?token=${CANARY}#${CANARY}`;

describe('what opm writes of a source URL the person gave', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'opm-source-credentials-'));
    temps.push(root);
    expect(await runOpm(['init', '--name', 'demo'], capture().io, root)).toBe(
      0,
    );
    return root;
  }

  it('opm add --source, offline', async () => {
    const root = await project();
    const cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/foo@1.0.0', '--source', SOURCE, '--offline'],
        cap.io,
        root,
      ),
    ).toBe(8);
    expect(cap.out + cap.err).not.toContain(CANARY);
    expect(cap.out + cap.err).not.toContain('user');
    expect(cap.err).toContain('https://host.example/x.tgz while offline');
  });

  it.each([['install'], ['sync']])(
    'opm %s, offline, with a source in opm.toml',
    async (verb) => {
      const root = await project();
      const manifest = join(root, 'opm.toml');
      await writeFile(
        manifest,
        `${await readFile(manifest, 'utf8')}\n[packages.foo]\npurl = "pkg:npm/foo"\nversion = "1.0.0"\nsource = "${SOURCE}"\n`,
      );
      const cap = capture();
      expect(await runOpm([verb, '--offline'], cap.io, root)).toBe(8);
      expect(cap.out + cap.err).not.toContain(CANARY);
      expect(cap.err).toContain('https://host.example/x.tgz while offline');
    },
  );

  async function withSource(source: string): Promise<string> {
    const root = await project();
    const manifest = join(root, 'opm.toml');
    await writeFile(
      manifest,
      `${await readFile(manifest, 'utf8')}\n[packages.foo]\npurl = "pkg:npm/foo"\nversion = "1.0.0"\nsource = ${JSON.stringify(source)}\n`,
    );
    return root;
  }

  /** Alphanumeric, so it is a legal scheme as well. */
  const USER = 'vtokdummymarker0123456789abcdef';

  it.each([
    [SOURCE, 'https://host.example/x.tgz'],
    [
      `git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`,
      'git+https://github.com/o/r.git',
    ],
    [`git+ssh://${CANARY}@github.com:o/r.git`, 'git+ssh:[address withheld]'],
    [`${CANARY}@github.com:o/r.git`, '[address withheld]'],
    [`${USER}:pw@github.com:o/r.git`, '[address withheld]'],
    [`${USER}:pw/x@host.example/y.tgz`, '[address withheld]'],
  ])('opm why names the source %s as %s', async (source, shown) => {
    const root = await withSource(source);
    const cap = capture();
    expect(await runOpm(['why', 'foo'], cap.io, root)).toBe(0);
    expect(cap.out + cap.err).not.toContain(CANARY);
    expect((cap.out + cap.err).toLowerCase()).not.toContain(USER);
    expect(cap.out).toContain(`  source: ${shown}\n`);
  });

  it('opm why still names a path the person wrote', async () => {
    for (const source of [
      './artifacts/foo-1.0.0.tgz',
      '/srv/artifacts/foo@1.0.0.tgz',
      'C:\\artifacts\\foo.tgz',
    ]) {
      const cap = capture();
      expect(
        await runOpm(['why', 'foo'], cap.io, await withSource(source)),
      ).toBe(0);
      expect(cap.out).toContain(`  source: ${source}\n`);
    }
  });

  it.each([
    [
      `git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`,
      'git+https://github.com/o/r.git',
    ],
    [`git+ssh://${CANARY}@github.com:o/r.git`, 'git+ssh:[address withheld]'],
    [`${CANARY}@github.com:o/r.git`, '[address withheld]'],
    [`${USER}:pw@github.com:o/r.git`, '[address withheld]'],
    [`${USER}:pw@ho st:o/r`, '[address withheld]'],
    [`github:u:${CANARY}@o/r`, 'github:[address withheld]'],
  ])(
    'opm install, offline, names a missing source %s as %s',
    async (source, shown) => {
      const root = await withSource(source);
      const cap = capture();
      expect(await runOpm(['install', '--offline'], cap.io, root)).toBe(4);
      expect(cap.out + cap.err).not.toContain(CANARY);
      expect((cap.out + cap.err).toLowerCase()).not.toContain(USER);
      expect(cap.err).toContain(`Artifact source not found: ${shown}\n`);
    },
  );

  it('opm add --source names a missing source that is a URL as one', async () => {
    const root = await project();
    const cap = capture();
    const source = `git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`;
    expect(
      await runOpm(
        ['add', 'pkg:npm/foo@1.0.0', '--source', source, '--offline'],
        cap.io,
        root,
      ),
    ).toBe(4);
    expect(cap.out + cap.err).not.toContain(CANARY);
    expect(cap.err).toContain(
      'Artifact source not found: git+https://github.com/o/r.git\n',
    );
  });

  it('opm install still names a missing file by its path', async () => {
    const root = await withSource('./missing/foo-1.0.0.tgz');
    const cap = capture();
    expect(await runOpm(['install', '--offline'], cap.io, root)).toBe(4);
    expect(cap.err).toContain(
      `Artifact source not found: ${join(root, 'missing', 'foo-1.0.0.tgz')}\n`,
    );
  });
});
