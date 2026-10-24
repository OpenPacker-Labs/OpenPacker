import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { capture } from './capture.js';
import { linkBins, run } from './bins-fixture.js';

/**
 * `opm ci` names the entries of a lock it cannot install, and a lock's
 * `resolved` can hold a person's credentials: in userinfo, in a query, in a
 * fragment, or in a password that holds the characters that end userinfo. Each
 * address here carries its own marker, and nothing `opm ci` writes, to either
 * stream, may hold one. Each list is run through `runOpm` and through the built
 * binary, started as `bins.test.ts` starts one.
 */

const marker = (index: number) =>
  `vtok_dummy_marker_${String(index).padStart(2, '0')}_0123456789abcdef`;

/** Addresses `opm ci` classes as git or path sources and lists. */
const SOURCES: readonly ((c: string) => string)[] = [
  (c) => `git+https://deploy:${c}@example.test:8443/o/b.git?token=${c}#${c}`,
  (c) => `git+ssh://deploy:${c}@github.com:o/r.git`,
  (c) => `git+ssh://git@github.com:o/r.git?token=${c}#${c}`,
  (c) => `git+ssh://deploy:${c}@x@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}?x#y@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}/y@github.com:o/r.git`,
  (c) => `git+ssh://deploy:a/${c}@github.com:o/r.git`,
  (c) => `git+ssh://deploy:a/b@${c}@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}:y@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}@x?y@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}@x#y@github.com:o/r.git`,
  (c) => `git+ssh://deploy:${c}@x/y@github.com:o/r.git`,
  (c) => `git+https://deploy:${c}@x/y@github.com/o/r.git`,
  (c) => `github:o/r?token=${c}#${c}`,
  (c) => `github:u:${c}@o/r`,
  (c) => `file:///srv/pkg?x=${c}#y`,
];

/** More git sources: a screen lists twenty, so these are a lock of their own. */
const MORE_SOURCES: readonly ((c: string) => string)[] = [
  // An `@` in a query or a fragment is where a password may end.
  (c) => `git+https://github.com/o/r.git?email=a@b.com&sig=${c}`,
  (c) => `git+https://github.com/o/r.git#user@feature&sig=${c}`,
  (c) => `git+ssh://git@github.com/o/r.git#semver:@scope/pkg@${c}`,
  (c) => `git+https://example.test/o/r.git?x=a@b&access=${c}`,
  (c) => `github:o/r#feature@${c}`,
  // A password the parser reads as a host, a port and a path.
  (c) => `git+https://deploy:/${c}/@example.test:8443/o/b.git`,
  (c) => `git+ssh://deploy:/${c}/@github.com/o/r.git`,
  (c) => `git+ssh://deploy:1234/${c}@github.com/o/r.git`,
  (c) => `git+ssh://deploy:@${c}@x?y@github.com/o/r.git`,
];

/** Addresses `opm ci` refuses by name, with a reason of its own. */
const REFUSED: readonly ((c: string) => string)[] = [
  (c) => `https://u:${c}@ho st/x?q=${c}#${c}`,
  (c) => `https://u:${c}@[::1/x?q=${c}#${c}`,
  (c) => `https://u:${c}/y@ho st/z`,
  (c) => `https://u:${c}@registry.example.test/f/-/f-1.0.0.tgz?t=${c}#${c}`,
  (c) => `https://u:${c}@${'a'.repeat(300)}.test/f/-/f-1.0.0.tgz?t=${c}#${c}`,
  (c) => `https://u:${c}@x[:${'ß.é.'.repeat(80)}/f.tgz?t=${c}`,
  (c) => `file://u:${c}@${'ß.é.'.repeat(80)}/x?t=${c}`,
  (c) => `user:${c}@host:o/r`,
  (c) => `blob:https://u:${c}@h/x`,
  (c) => `ssh://u:${c}@h/p?x=${c}#${c}`,
  (c) => `ftp://u:${c}@h/p?x=${c}#${c}`,
];

/**
 * `user:password@host:path` is a valid URL whose scheme is the user name, so an
 * alphanumeric user name must not be printed as one. (The markers above hold an
 * underscore, which is not a scheme character, and could never be one.)
 */
const alphanumeric = (c: string) => c.replaceAll('_', '');
const SCHEMELESS: readonly ((c: string) => string)[] = [
  (c) => `${alphanumeric(c)}:pw@github.com:o/r.git`,
  (c) => `${alphanumeric(c).toUpperCase()}:x@host.example:o/r?y#z`,
  (c) => `${alphanumeric(c)}:${alphanumeric(c)}@github.com:o/r.git`,
  (c) => `${alphanumeric(c)}:@github.com:o/r.git`,
  (c) => `${alphanumeric(c)}:pw@ho st:o/r`,
  (c) => `blob:${alphanumeric(c)}:pw@github.com:o/r.git`,
];

describe('what opm ci writes of a lock entry it cannot install', () => {
  const temps: string[] = [];
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.OPM_STORE_HOME;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = previous;
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /** A project whose lock holds one entry per source, each with its own marker. */
  async function lock(
    sources: readonly ((c: string) => string)[],
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'opm-credentials-'));
    const store = await mkdtemp(join(tmpdir(), 'opm-credentials-store-'));
    temps.push(dir, store);
    process.env.OPM_STORE_HOME = join(store, 'shared');
    const dependencies: Record<string, string> = {};
    const packages: Record<string, unknown> = {};
    sources.forEach((source, index) => {
      const name = `p${index}`;
      dependencies[name] = '1.0.0';
      packages[`node_modules/${name}`] = {
        version: '1.0.0',
        resolved: source(marker(index)),
        integrity: `sha512-${createHash('sha512').update(name).digest('base64')}`,
      };
    });
    const root = { name: 'app', version: '1.0.0', dependencies };
    await writeFile(join(dir, 'package.json'), JSON.stringify(root));
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': root, ...packages },
      }),
    );
    return dir;
  }

  async function ci(sources: readonly ((c: string) => string)[]) {
    const dir = await lock(sources);
    const cap = capture();
    const code = await runOpm(['ci', '--offline', '--path', dir], cap.io, '/');
    return { code, written: cap.out + cap.err };
  }

  /** The same, through the file `bin.opm` names, started the way a link starts it. */
  async function ciBinary(sources: readonly ((c: string) => string)[]) {
    const dir = await lock(sources);
    const entry = (await linkBins({ opm: './dist/main.js' })).get('opm')!;
    const finished = await run(entry, ['ci', '--offline', '--path', dir], '/');
    return {
      code: finished.status,
      written: finished.stdout + finished.stderr,
    };
  }

  describe.each([
    ['runOpm', ci],
    ['the built binary', ciBinary],
  ])('through %s', (_, through) => {
    it.each([
      ['listed as git or path sources', SOURCES],
      ['listed as git sources with an @ after the authority', MORE_SOURCES],
      ['refused by name', REFUSED],
    ])(
      'holds no credential of an entry %s',
      async (_, sources) => {
        const { code, written } = await through(sources);
        expect(code).toBe(3);
        // The lock was refused for these entries, not for something else.
        for (let index = 0; index < sources.length; index += 1)
          expect(written, `entry p${index}`).toContain(`p${index}@1.0.0`);
        expect(written).not.toMatch(/vtok_dummy_marker/u);
        expect(written).not.toContain('deploy');
      },
      120_000,
    );

    it('does not print a user name written before a colon as a scheme', async () => {
      const { code, written } = await through(SCHEMELESS);
      expect(code).toBe(3);
      for (let index = 0; index < SCHEMELESS.length; index += 1)
        expect(written, `entry p${index}`).toContain(`p${index}@1.0.0`);
      expect(written.toLowerCase()).not.toContain('vtokdummymarker');
    }, 120_000);
  });
});
