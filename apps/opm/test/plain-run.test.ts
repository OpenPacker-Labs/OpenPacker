import { describe, expect, it } from 'vitest';
import { expectPlain, runWith } from './plain-fixture.js';

/**
 * What a repository calls a directory cannot shape what `opm run` and `opm exec`
 * write when they name the project they found in it: the path is made one line
 * where a message quotes it, so that no line looks like opm's own after any kind
 * of line break, none holds a character a terminal acts on, and the output has
 * the lines it has for an innocent name. (A directory can hold anything in its
 * name but a slash and a NUL.)
 */
describe('opm run and exec, for a project in a directory a repository named', () => {
  const directory = (text: string) => `p${text.replaceAll('/', '_')}`;
  const inside = (text: string, files: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        `${directory(text)}/${name}`,
        body,
      ]),
    );

  it.each<[string, Record<string, string>, string[], string]>([
    [
      'a bin that is there and not executable',
      {
        'node_modules/.bin/ax': '#!/bin/sh\n',
        'package.json': '{"name":"p"}',
      },
      ['exec', 'ax'],
      'exists but is not executable',
    ],
    ['no package.json', { 'x.txt': '' }, ['run'], 'No package.json in '],
    [
      'a package.json that is not JSON',
      { 'package.json': '{' },
      ['run'],
      ' is not valid JSON: ',
    ],
    [
      'a package.json that is not an object',
      { 'package.json': '[]' },
      ['run'],
      ' is not a JSON object',
    ],
    [
      'a package.json larger than it may be',
      { 'package.json': ' '.repeat(4 * 1024 * 1024 + 1) },
      ['run'],
      ' is larger than ',
    ],
    [
      'scripts that are not an object',
      { 'package.json': '{"scripts":1}' },
      ['run'],
      '"scripts" in ',
    ],
    [
      'a script that is not there',
      { 'package.json': '{"scripts":{"a":"echo a"}}' },
      ['run', 'missing'],
      'No script "missing" in ',
    ],
    [
      'a script that is not a string',
      { 'package.json': '{"scripts":{"a":1}}' },
      ['run', 'a'],
      'Script "a" in ',
    ],
  ])('names the directory on one line: %s', async (_, files, argv, shown) => {
    const go = (text: string) =>
      runWith(inside(text, files), [
        argv[0]!,
        '--path',
        directory(text),
        ...argv.slice(1),
      ]);
    const innocent = await go('x');
    expect(innocent.code).not.toBe(0);
    expect(innocent.err).toContain(shown);
    await expectPlain(go);
  });
});
