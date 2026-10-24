import { describe, expect, it } from 'vitest';
import {
  CONFUSIONS,
  describePath,
  isObject,
  pathsOf,
  replaced,
  type Json,
} from '../../../packages/opm-project/test/type-confusion.js';
import { opmFiles, runIn } from './repo-fixture.js';

/**
 * What the commands do with a lock or a manifest that holds a field of the wrong
 * type. `opm-project`'s own fuzz holds the readers to it (`parseLockfile` and
 * `parseManifest` read or refuse with their code); this runs the commands that
 * read the two files, through `runOpm`, with each field replaced by a value of
 * another type, and requires that none ends as `opm: internal error: ...`, which
 * is how an uncoded `TypeError` or `SyntaxError` reaches a person.
 */
const COMMANDS: readonly string[][] = [
  ['list'],
  ['why', 'a'],
  ['install', '--offline'],
  ['sync', '--offline'],
  ['manifest'],
  ['update', '--offline'],
  ['generations'],
  ['gc'],
];

/** The values tried at each field: one of each type a reader might not expect. */
const SAMPLE: readonly Json[] = [null, 5, 'x', [], {}];

async function internalErrors(
  files: Record<string, string>,
  what: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const argv of COMMANDS) {
    const ran = await runIn(files, argv);
    if (/internal error/u.test(ran.err))
      failures.push(
        `${what} | opm ${argv.join(' ')}: ${ran.err.split('\n')[0]}`,
      );
  }
  return failures;
}

describe('the commands that read opm.lock.json', () => {
  const base = opmFiles(() => undefined);
  const lock: Json = JSON.parse(base['opm.lock.json']);

  it('run on the lock that holds every field', async () => {
    expect(await internalErrors(base, 'the lock as it is')).toEqual([]);
  });

  it('end in an error with a code, not an internal one, for a field of any type', async () => {
    const paths = pathsOf(lock);
    expect(paths.length).toBeGreaterThan(15);
    const failures: string[] = [];
    for (const path of paths)
      for (const value of SAMPLE) {
        const files = {
          ...base,
          'opm.lock.json': JSON.stringify(replaced(lock, path, value)),
        };
        failures.push(
          ...(await internalErrors(
            files,
            `${describePath(path)} = ${JSON.stringify(value)}`,
          )),
        );
      }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('the commands that read opm.toml', () => {
  const base = opmFiles(() => undefined, { plugin: true });
  const lines = base['opm.toml'].split('\n');
  const assignments = lines.flatMap((line, index) =>
    /^[A-Za-z0-9_.-]+ = /u.test(line) ? [index] : [],
  );
  const VALUES = ['5', '"x"', '[]', '["x"]', '[1]', '{ a = 1 }', '"a" "b"'];

  it('end in an error with a code, not an internal one, for a value of any shape', async () => {
    expect(assignments.length).toBeGreaterThan(6);
    const failures: string[] = [];
    for (const index of assignments)
      for (const value of VALUES) {
        const copy = [...lines];
        copy[index] = `${lines[index]!.split(' = ')[0]} = ${value}`;
        failures.push(
          ...(await internalErrors(
            { ...base, 'opm.toml': copy.join('\n') },
            copy[index]!,
          )),
        );
      }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('the fuzz', () => {
  it('walks objects and arrays', () => {
    expect(isObject({ a: 1 })).toBe(true);
    expect(CONFUSIONS.length).toBeGreaterThan(10);
  });
});
