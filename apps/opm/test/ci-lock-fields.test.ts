import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * Fields of a lock that `opm ci` repeats in what it refuses: an entry's
 * `version` and `name`, the target of a link, and the key of an entry in
 * `packages`. A lock npm wrote holds a semver in the first, and a name or a path
 * in the rest, but opm reads a lock anyone can hand it. Each is made plain (no
 * escape sequence, control or bidirectional character), and a value that is an
 * address, or holds one, is shown as every address is shown (`redactAddress`).
 */

const MARKER = 'vtok_dummy_marker_0123456789abcdef';
/** An address that carries the marker three ways, behind characters a terminal acts on. */
const ADDRESS = `https://user:${MARKER}@host.example/x.tgz?token=${MARKER}#${MARKER}`;
const WRAPPED = `\u001b[31m\u001b]0;title\u0007${ADDRESS}\u0000\b‮​`;
/** The same behind a word, so that it is in the field and not the field. */
const EMBEDDED = `left-pad/${WRAPPED} and ${WRAPPED}`;

function integrity(name: string): string {
  return `sha512-${createHash('sha512').update(name).digest('base64')}`;
}

type Entry = Record<string, unknown>;

describe('what opm ci repeats of the fields of a lock entry it refuses', () => {
  const temps: string[] = [];
  let previous: string | undefined;
  afterEach(async () => {
    if (previous === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = previous;
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function ci(packages: Record<string, Entry>) {
    previous = process.env.OPM_STORE_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'opm-lock-fields-'));
    const store = await mkdtemp(join(tmpdir(), 'opm-lock-fields-store-'));
    temps.push(dir, store);
    process.env.OPM_STORE_HOME = join(store, 'shared');
    const dependencies: Record<string, string> = {};
    for (const key of Object.keys(packages))
      if (/^node_modules\/p\d$/u.test(key))
        dependencies[key.slice('node_modules/'.length)] = '*';
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
    const cap = capture();
    const code = await runOpm(['ci', '--offline', '--path', dir], cap.io, '/');
    return { code, written: cap.out + cap.err };
  }

  /** Whether `text` holds only what a terminal shows: printable characters and line feeds. */
  function plain(text: string): boolean {
    return !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text.replaceAll('\n', ''));
  }

  const git = (name: string) => ({
    resolved: 'git+https://github.com/o/r.git#abcdef0',
    integrity: integrity(name),
  });

  const registry = (name: string) => ({
    resolved: `https://registry.example.com/${name}/-/${name}-1.0.0.tgz`,
    integrity: integrity(name),
  });

  /** Each field, in a form that is refused as a git source and in one that is fetched. */
  const FIELDS: [
    string,
    (value: string, source: Entry) => Record<string, Entry>,
  ][] = [
    [
      'the version of an entry',
      (value, source) => ({ 'node_modules/p0': { version: value, ...source } }),
    ],
    [
      'the name of an entry',
      (value, source) => ({
        'node_modules/p0': { name: value, version: '1.0.0', ...source },
      }),
    ],
    [
      'the key of an entry',
      (value, source) => ({
        [`node_modules/p0/node_modules/${value}`]: {
          version: '1.0.0',
          ...source,
        },
      }),
    ],
  ];

  describe.each([
    ['listed as a git source', git('p0')],
    ['fetched from a registry, offline', registry('p0')],
  ])('an entry %s', (_, source) => {
    it.each(
      FIELDS.flatMap(([field, build]) => [
        [field, build(WRAPPED, source)],
        [`${field}, with the address inside it`, build(EMBEDDED, source)],
      ]),
    )(
      'writes %s as plain text, without its credentials',
      async (_field, packages) => {
        const { code, written } = await ci(packages as Record<string, Entry>);
        expect(code).not.toBe(0);
        expect(written).toContain('p0');
        expect(written).not.toContain(MARKER);
        expect(written).not.toContain('user:');
        expect(plain(written)).toBe(true);
      },
    );
  });

  it.each([
    ['the target of a link', WRAPPED],
    ['the target of a link, with the address inside it', EMBEDDED],
  ])('writes %s as plain text, without its credentials', async (_, target) => {
    const { code, written } = await ci({
      'node_modules/p0': { link: true, resolved: target },
    });
    expect(code).toBe(3);
    expect(written).toContain('node_modules/p0: a link that points at ');
    expect(written).not.toContain(MARKER);
    expect(written).not.toContain('user:');
    expect(plain(written)).toBe(true);
  });

  it('still writes an ordinary version, name, link and key as they are', async () => {
    const { code, written } = await ci({
      'node_modules/p0': { version: '1.2.3+build.5', ...git('p0') },
      'node_modules/p1': {
        name: '@scope/real-name',
        version: '2.0.0',
        ...git('p1'),
      },
    });
    expect(code).toBe(3);
    expect(written).toContain('p0@1.2.3+build.5 (node_modules/p0)');
    expect(written).toContain('@scope/real-name@2.0.0 (node_modules/p1)');
    const link = await ci({
      'node_modules/p2': { link: true, resolved: '../packages/shared' },
    });
    expect(link.written).toContain(
<<<<<<< ours
      'a link that points at ../packages/shared, which leaves the project root;',
=======
      'a link that points at ../packages/shared, which leaves',
>>>>>>> theirs
    );
  });
});
