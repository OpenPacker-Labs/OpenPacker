import { describe, expect, it } from 'vitest';
import {
  expectNoNewLines,
  forgedLines,
  lineCount,
  member,
  opmFiles,
  PAYLOAD,
  renameKey,
  runIn,
  type Json,
  type TomlSections,
} from './repo-fixture.js';

/**
 * A cloned repository cannot add a line to what opm writes. The values in its
 * opm.toml and opm.lock.json are repeated in the errors every command that
 * reads them can raise, so each is made one line where it is repeated.
 */

type Edit = (lock: Json, toml: TomlSections, text: string) => void;

const repo =
  (edit: Edit, options: { plugin?: boolean } = {}) =>
  (text: string) =>
    opmFiles((lock, toml) => edit(lock, toml, text), options);

const lockPackage = (lock: Json): Json => member(lock, 'packages', 'a');

describe('opm list, in a repository whose opm.lock.json holds', () => {
  it.each<[string, Edit]>([
    [
      'a schemaVersion that is not 1',
      (lock, _toml, text) => {
        lock.schemaVersion = `1${text}`;
      },
    ],
    [
      'a generatedBy that is not opm',
      (lock, _toml, text) => {
        lock.generatedBy = `opm${text}`;
      },
    ],
    [
      'a format that is not an archive format',
      (lock, _toml, text) => {
        lockPackage(lock).format = `zip${text}`;
      },
    ],
    [
      'a package with a size that is not one',
      (lock, _toml, text) => {
        renameKey(member(lock, 'packages'), 'a', `a${text}`);
        member(lock, 'packages', `a${text}`).size = -1;
      },
    ],
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo(edit), ['list']);
  });
});

describe('opm remove, in a repository whose lock names a package', () => {
  it('refuses an alias that holds a line feed in one line', async () => {
    const ran = await runIn(
      repo((lock, _toml, text) =>
        renameKey(member(lock, 'packages'), 'a', `a${text}`),
      )(PAYLOAD),
      ['remove', 'a'],
    );
    expect(forgedLines(ran.err)).toEqual([]);
    expect(lineCount(ran.err)).toBe(1);
  });
});

describe('opm sync, in a repository whose opm.toml holds', () => {
  it.each<[string, Edit]>([
    [
      'a purl it cannot resolve',
      (_lock, toml, text) => {
        toml.a.purl = `pkg:npm/a${text}`;
      },
    ],
    [
      'a version it cannot resolve',
      (_lock, toml, text) => {
        toml.a.version = `1.0.0${text}`;
      },
    ],
  ])('one line, when it is %s', async (_, edit) => {
    await expectNoNewLines(repo(edit), ['sync', '--offline']);
  });
});

describe('opm install, in a repository whose opm.toml holds', () => {
  it.each<[string, Edit, { plugin?: boolean }]>([
    [
      'a layout that is not opm',
      (_lock, toml, text) => {
        toml.options.layout = `opm${text}`;
      },
      {},
    ],
    [
      'a plugin binding with a digest that is not one',
      (_lock, toml, text) => {
        if (toml.plugin) toml.plugin.store_digest = `sha256:${text}`;
      },
      { plugin: true },
    ],
  ])('one line, when it is %s', async (_, edit, options) => {
    await expectNoNewLines(repo(edit, options), ['install', '--offline']);
  });
});

describe('opm, in a repository whose files are not what they claim', () => {
  /** The payload with carriage returns, which the CLI's writer reads as line feeds. */
  const carriageReturns = (text: string) => text.replaceAll('\n', '\r');

  it.each<[string, (valid: string, text: string) => string]>([
    ['opm.toml', (valid, text) => `${carriageReturns(text)}${valid}`],
    [
      'opm.toml',
      (valid, text) =>
        valid.replace('name = "demo"', `name = "demo${carriageReturns(text)}`),
    ],
    [
      'opm.toml',
      (valid, text) => valid.replace('[', `[${carriageReturns(text)}`),
    ],
  ])('one line, when %s holds a carriage return (%#)', async (name, mutate) => {
    const valid = opmFiles(() => {})['opm.toml'];
    await expectNoNewLines(
      (text) => ({ ...opmFiles(() => {}), [name]: mutate(valid, text) }),
      ['why', 'a'],
    );
  });
});
