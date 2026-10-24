/**
 * The names a patch may create are the names an archive may hold (ADR 0057
 * §13). `aux.js`, `CON`, `nul.txt`, `a:b`, `trailing.` and `com1.json` were
 * taken by `opm ci --plan` and created by the install, where an archive
 * refuses them (the materializer's rule, now the one in
 * `@openpacker/adapter-core`); on Windows a patch that creates `lib/CON` or
 * `a:b` would write to a device or a stream. The seventh of the review's
 * names, `space `, cannot be written in a patch (see below). A name past what a file system
 * takes, 255 bytes, was a raw `ENAMETOOLONG` naming a store temporary at
 * install; it is a refusal at `--plan`.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPnpmPatch, readPatchText } from './index.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

/** Six of the seven; the seventh, `lib/space `, cannot be named: see below. */
const SIX = [
  'lib/aux.js',
  'lib/CON',
  'lib/nul.txt',
  'lib/a:b',
  'lib/trailing.',
  'lib/com1.json',
];

const patchOf = (text: string) => ({
  key: 'x@1.0.0',
  file: 'p.patch',
  hash: '',
  digest: '',
  text,
});

const refused = (code: string, words: string) =>
  expect.objectContaining({ code, message: expect.stringContaining(words) });

describe('a name an archive refuses', () => {
  it.each(SIX)('is refused at --plan: %j', (path) => {
    expect(() => readPatchText(create(path), 'p.patch')).toThrow(
      refused('UNSAFE_PATH', 'an archive refuses it on every platform'),
    );
  });

  it.each(SIX)(
    'is refused at install, and nothing is created: %j',
    async (path) => {
      const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-names-'));
      temps.push(dir);
      await writeFile(join(dir, 'package.json'), '{}');
      await expect(
        applyPnpmPatch(dir, patchOf(create(path)), 'x@1.0.0'),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(await readdir(dir)).toEqual(['package.json']);
    },
  );

  it('is refused as a directory on the way, a rename target and a deletion alike', () => {
    expect(() => readPatchText(create('lib/CON/x.js'), 'p')).toThrow(
      refused('UNSAFE_PATH', '"CON"'),
    );
    const rename = [
      'diff --git a/lib/a.js b/lib/aux.js',
      'rename from lib/a.js',
      'rename to lib/aux.js',
      '',
    ].join('\n');
    expect(() => readPatchText(rename, 'p')).toThrow(
      refused('UNSAFE_PATH', '"lib/aux.js"'),
    );
    const removal = 'diff --git a/lib/a: b/lib/a:\ndeleted file mode 100644\n';
    expect(() => readPatchText(removal, 'p')).toThrow(
      refused('UNSAFE_PATH', 'alternate data stream'),
    );
  });

  it("cannot be a name that ends in a space: the parser, as pnpm's, takes the whitespace off the end of a path", async () => {
    // So `lib/space ` is `lib/space`, an ordinary name, in every line that
    // names a path, and the install creates that.
    const effects = readPatchText(create('lib/space '), 'p');
    expect(effects).toMatchObject([{ path: 'lib/space' }]);
    const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-space-'));
    temps.push(dir);
    await applyPnpmPatch(dir, patchOf(create('lib/space ')), 'x@1.0.0');
    expect(await readdir(join(dir, 'lib'))).toEqual(['space']);
  });

  it.each(['lib/X.js', 'lib/console.js', 'lib/auxiliary', 'lib/com10.js'])(
    'is not a name that merely starts or ends like one: %j',
    (path) => {
      expect(readPatchText(create(path), 'p')).toHaveLength(1);
    },
  );
});

describe('a name past what a file system takes', () => {
  it('may be 255 bytes and is refused at 256, counting bytes and not characters, at --plan', () => {
    expect(readPatchText(create(`lib/${'a'.repeat(255)}`), 'p')).toHaveLength(
      1,
    );
    expect(() => readPatchText(create(`lib/${'a'.repeat(256)}`), 'p')).toThrow(
      refused('UNSAFE_PATH', 'a segment of 256 bytes, more than the 255'),
    );
    expect(readPatchText(create(`lib/${'é'.repeat(127)}`), 'p')).toHaveLength(
      1,
    );
    expect(() => readPatchText(create(`lib/${'é'.repeat(128)}`), 'p')).toThrow(
      refused('UNSAFE_PATH', 'a segment of 256 bytes'),
    );
  });

  it('is a directory on the way as much as a file', () => {
    expect(() => readPatchText(create(`${'d'.repeat(300)}/f.js`), 'p')).toThrow(
      refused('UNSAFE_PATH', 'a segment of 300 bytes'),
    );
  });
});
