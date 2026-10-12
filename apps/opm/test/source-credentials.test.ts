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
});
