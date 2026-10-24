import { isAddress } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import { fetchArtifactBytes } from '../src/install.js';
import { shownSource } from '../src/shown-source.js';

/** Stands for a credential a source holds. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';
/** Alphanumeric, so it is a legal scheme as well. */
const USER = 'vtokdummymarker0123456789abcdef';

describe('a source a person wrote, as an error names it', () => {
  it.each([
    [`https://user:${CANARY}@host.example/x.tgz?t=${CANARY}`, true],
    [`git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`, true],
    [`git+ssh://${CANARY}@github.com:o/r.git`, true],
    [`${CANARY}@github.com:o/r.git`, true],
    [`${USER}:pw@github.com:o/r.git`, true],
    [`a:pw@host.example:o/r`, true],
    [`github:u:${CANARY}@o/r`, true],
    [`file:///srv/pkg.tgz?token=${CANARY}`, true],
    // The URL parser removes tabs and line breaks inside a text, and the
    // controls and spaces before it.
    [`git+ht\ttps://user:${CANARY}@github.com/o/r.git`, true],
    [` \n git+https://user:${CANARY}@github.com/o/r.git`, true],
    ['./artifacts/foo-1.0.0.tgz', false],
    ['../foo.tgz', false],
    ['/srv/artifacts/foo@1.0.0.tgz', false],
    ['foo@1.0.0.tgz', false],
    ['foo.tgz', false],
    ['C:\\artifacts\\foo.tgz', false],
    ['C:/artifacts/foo.tgz', false],
    ['~/foo.tgz', false],
    ['', false],
  ])('%j is an address: %s', (source, address) => {
    expect(isAddress(source)).toBe(address);
  });

  it.each([
    [
      `https://user:${CANARY}@host.example/x.tgz?t=${CANARY}#f`,
      'https://host.example/x.tgz',
    ],
    [
      `git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`,
      'git+https://github.com/o/r.git',
    ],
    [`git+ssh://${CANARY}@github.com:o/r.git`, 'git+ssh:[address withheld]'],
    [`${CANARY}@github.com:o/r.git`, '[address withheld]'],
    [`${USER}:pw@github.com:o/r.git`, '[address withheld]'],
    [`github:u:${CANARY}@o/r`, 'github:[address withheld]'],
    [
      `git+ht\ttps://user:${CANARY}@github.com/o/r.git`,
      'git+https://github.com/o/r.git',
    ],
    ['./artifacts/foo-1.0.0.tgz', './artifacts/foo-1.0.0.tgz'],
    ['/srv/artifacts/foo@1.0.0.tgz', '/srv/artifacts/foo@1.0.0.tgz'],
  ])('names %j as %j', (source, shown) => {
    expect(shownSource(source)).toBe(shown);
  });

  it('names a file: source by the file, and a path by the path it was read as', () => {
    expect(
      shownSource(`file:///srv/pkg.tgz?token=${CANARY}`, '/srv/pkg.tgz'),
    ).toBe('/srv/pkg.tgz');
    expect(shownSource('./foo.tgz', '/work/foo.tgz')).toBe('/work/foo.tgz');
    expect(
      shownSource(
        `git+https://u:${CANARY}@h.example/o/r.git`,
        '/work/git+https:/u:C@h.example/o/r.git',
      ),
    ).toBe('git+https://h.example/o/r.git');
  });

  it('makes a path one line', () => {
    const shown = shownSource('./a\u001b[31m\nb.tgz');
    expect(shown).not.toContain('\u001b');
    expect(shown).not.toContain('\n');
  });

  it('is what fetchArtifactBytes names, when it is told what was written', async () => {
    const written = `git+https://user:${CANARY}@github.com/o/r.git#${CANARY}`;
    const error = await fetchArtifactBytes(
      `/nowhere/git+https:/user:${CANARY}@github.com/o/r.git#${CANARY}`,
      true,
      { written },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Artifact source not found: git+https://github.com/o/r.git',
    });
    const plain = await fetchArtifactBytes('/nowhere/foo.tgz', true).catch(
      (caught: unknown) => caught,
    );
    expect(plain).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Artifact source not found: /nowhere/foo.tgz',
    });
  });
});
