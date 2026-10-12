import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  DEPENDENCY_FIELDS,
  parseFilter,
  selectMembers,
  selectNpmWorkspaces,
  starMatches,
} from '../src/index.js';
import { codeOf, type Tree } from './workspace-helpers.js';
import { graphOf } from './workspace-graph-helpers.js';

const parse = (text: string, cwd = '') =>
  parseFilter(text, { cwd, limits: DEFAULT_WORKSPACE_LIMITS });

/** a -> b -> c, d -> b, and e alone; scoped like HoBo's. */
const tree: Tree = {
  '': { name: 'hobo-design' },
  'packages/a': { name: '@h/a', dependencies: { '@h/b': 'workspace:*' } },
  'packages/b': { name: '@h/b', dependencies: { '@h/c': 'workspace:*' } },
  'packages/c': { name: '@h/c' },
  'packages/d': { name: '@h/d', devDependencies: { '@h/b': 'workspace:*' } },
  'packages/e': { name: '@h/e' },
  'tools/site': { name: 'hobo-site', dependencies: { '@h/a': 'workspace:*' } },
  'tools/nested/deep': { name: 'deep' },
};
const graph = graphOf(tree);
const pick = (...filters: string[]) =>
  selectMembers(
    graph,
    filters.map((f) => parse(f)),
  ).selected;
const names = (dirs: readonly string[]) =>
  dirs.map((dir) => graph.index.byDir.get(dir)?.name ?? '?');

describe('parsing a filter', () => {
  it.each([
    [
      '@h/a',
      {
        exclude: false,
        includeDependencies: false,
        includeDependents: false,
        excludeSelf: false,
        name: '@h/a',
      },
    ],
    ['@h/*', { name: '@h/*' }],
    [
      '@h/a...',
      {
        includeDependencies: true,
        includeDependents: false,
        excludeSelf: false,
      },
    ],
    [
      '...@h/a',
      {
        includeDependents: true,
        includeDependencies: false,
        excludeSelf: false,
      },
    ],
    [
      '@h/a^...',
      { includeDependencies: true, excludeSelf: true, name: '@h/a' },
    ],
    ['...^@h/a', { includeDependents: true, excludeSelf: true, name: '@h/a' }],
    ['...@h/a...', { includeDependents: true, includeDependencies: true }],
    ['!@h/a', { exclude: true, name: '@h/a' }],
    ['!...@h/a', { exclude: true, includeDependents: true }],
    ['./packages/a', { name: undefined, directory: { kind: 'glob' } }],
    ['{packages/a}', { directory: { kind: 'glob' } }],
    ['@h/a{packages}', { name: '@h/a', directory: { kind: 'glob' } }],
    [
      '{./packages/a}...',
      { includeDependencies: true, directory: { kind: 'glob' } },
    ],
  ])('reads %s', (text, expected) => {
    expect(parse(text)).toMatchObject(expected);
  });

  it('reads a path from the directory the command ran in', () => {
    const where = (text: string, cwd: string) =>
      selectMembers(graph, [parse(text, cwd)], { allowEmpty: true }).selected;
    expect(where('./b', 'packages')).toEqual(['packages/b']);
    expect(where('../tools/*', 'packages')).toEqual(['tools/site']);
    expect(where('{../packages/c}', 'tools')).toEqual(['packages/c']);
    expect(where('.', 'packages/a')).toEqual(['packages/a']);
    expect(where('..', 'packages/a')).toEqual([]);
    expect(codeOf(() => parse('../..', 'packages'))).toBe(
      'WORKSPACE_FILTER_INVALID',
    );
    expect(codeOf(() => parse('{../../x/*}', 'packages'))).toBe(
      'WORKSPACE_FILTER_INVALID',
    );
  });

  it.each([
    ['', 'WORKSPACE_FILTER_INVALID'],
    ['  ', 'WORKSPACE_FILTER_INVALID'],
    ['...', 'WORKSPACE_FILTER_INVALID'],
    ['!!x', 'WORKSPACE_FILTER_INVALID'],
    ['{a}{b}', 'WORKSPACE_FILTER_INVALID'],
    ['.hidden', 'WORKSPACE_FILTER_INVALID'],
    ['{a\\b}', 'WORKSPACE_FILTER_INVALID'],
    ['{a{b}', 'WORKSPACE_FILTER_INVALID'],
    ['./a...', 'WORKSPACE_FILTER_UNSUPPORTED'],
    ['...../a', 'WORKSPACE_FILTER_UNSUPPORTED'],
    ['[origin/main]', 'WORKSPACE_FILTER_UNSUPPORTED'],
    ['@h/a[origin/main]', 'WORKSPACE_FILTER_UNSUPPORTED'],
    ['...[HEAD~1]', 'WORKSPACE_FILTER_UNSUPPORTED'],
  ])('refuses %j as %s', (text, code) => {
    expect(codeOf(() => parse(text))).toBe(code);
  });

  it('says git selection is not supported yet, naming the filter', () => {
    expect(() => parse('@h/a[origin/main]')).toThrowError(
      '"@h/a[origin/main]" selects by git history ([since]), which is not supported yet',
    );
  });
});

describe('name patterns', () => {
  it('treats * as any run of characters, "/" included, and ? as itself', () => {
    expect(starMatches('@h/*', '@h/a')).toBe(true);
    expect(starMatches('@h/*', '@h/a/b')).toBe(true);
    expect(starMatches('@*/a', '@h/a')).toBe(true);
    expect(starMatches('*', 'anything')).toBe(true);
    expect(starMatches('a*c*e', 'abcde')).toBe(true);
    expect(starMatches('a*c*e', 'abde')).toBe(false);
    expect(starMatches('a?', 'ab')).toBe(false);
    expect(starMatches('a?', 'a?')).toBe(true);
    expect(starMatches('@h/a', '@h/ab')).toBe(false);
    expect(starMatches('ab*ab', 'ab')).toBe(false);
  });
});

describe('selecting', () => {
  it('selects by exact name, by wildcard and by directory', () => {
    expect(names(pick('@h/a'))).toEqual(['@h/a']);
    expect(names(pick('@h/*'))).toEqual([
      '@h/a',
      '@h/b',
      '@h/c',
      '@h/d',
      '@h/e',
    ]);
    expect(pick('./packages/b')).toEqual(['packages/b']);
    expect(pick('./tools/*')).toEqual(['tools/site']);
    expect(pick('{packages/*}')).toEqual([
      'packages/a',
      'packages/b',
      'packages/c',
      'packages/d',
      'packages/e',
    ]);
    expect(pick('{tools/**}')).toEqual(['tools/nested/deep', 'tools/site']);
    expect(pick('{**}')).toEqual(graph.members.map((m) => m.dir));
    expect(pick('@h/*{packages/[ab]}'.replace('[ab]', 'a'))).toEqual([
      'packages/a',
    ]);
  });

  it('takes the one scoped member for a bare name that matches nothing, as pnpm does', () => {
    expect(names(pick('a'))).toEqual(['@h/a']);
    expect(codeOf(() => pick('zzz'))).toBe('WORKSPACE_FILTER_NO_MATCH');
  });

  it('adds what a package depends on with name..., and what depends on it with ...name', () => {
    expect(names(pick('@h/a...'))).toEqual(['@h/a', '@h/b', '@h/c']);
    expect(names(pick('...@h/b'))).toEqual([
      '@h/a',
      '@h/b',
      '@h/d',
      'hobo-site',
    ]);
    expect(names(pick('...@h/c'))).toEqual([
      '@h/a',
      '@h/b',
      '@h/c',
      '@h/d',
      'hobo-site',
    ]);
  });

  it('leaves out the package itself with ^', () => {
    expect(names(pick('@h/a^...'))).toEqual(['@h/b', '@h/c']);
    expect(names(pick('...^@h/b'))).toEqual(['@h/a', '@h/d', 'hobo-site']);
  });

  it('adds both with ...name..., and the dependencies of the dependents too', () => {
    expect(names(pick('...@h/b...'))).toEqual([
      '@h/a',
      '@h/b',
      '@h/c',
      '@h/d',
      'hobo-site',
    ]);
    // hobo-site depends on @h/a, which depends on @h/b and @h/c: all of them come with it.
    expect(names(pick('...@h/e...'))).toEqual(['@h/e']);
  });

  it('is the union of several filters', () => {
    expect(names(pick('@h/e', '@h/c'))).toEqual(['@h/c', '@h/e']);
    expect(names(pick('@h/a...', 'hobo-site'))).toEqual([
      '@h/a',
      '@h/b',
      '@h/c',
      'hobo-site',
    ]);
  });

  it('takes away what ! selects, from everything when nothing else is selected', () => {
    expect(names(pick('@h/a...', '!@h/b'))).toEqual(['@h/a', '@h/c']);
    expect(names(pick('!@h/*'))).toEqual(['hobo-design', 'deep', 'hobo-site']);
    expect(names(pick('@h/*', '!...@h/b'))).toEqual(['@h/c', '@h/e']);
    expect(names(pick('!./tools/**'))).toEqual(
      names(graph.members.map((m) => m.dir)).filter(
        (n) => n !== 'deep' && n !== 'hobo-site',
      ),
    );
  });

  it('combines a name and a directory, narrowing to both', () => {
    expect(names(pick('@h/*{packages/a}'))).toEqual(['@h/a']);
    expect(codeOf(() => pick('@h/a{tools/*}'))).toBe(
      'WORKSPACE_FILTER_NO_MATCH',
    );
  });

  it('follows only the lists it is told to', () => {
    const selected = (fields: readonly (typeof DEPENDENCY_FIELDS)[number][]) =>
      names(selectMembers(graph, [parse('...@h/b')], { fields }).selected);
    expect(selected(['dependencies'])).toEqual(['@h/a', '@h/b', 'hobo-site']);
    expect(selected(DEPENDENCY_FIELDS)).toEqual([
      '@h/a',
      '@h/b',
      '@h/d',
      'hobo-site',
    ]);
  });

  it('leaves the root out when asked', () => {
    expect(
      names(
        selectMembers(graph, [parse('!@h/*')], { excludeRoot: true }).selected,
      ),
    ).toEqual(['deep', 'hobo-site']);
  });
});

describe('a directory selector', () => {
  /** p/a holds a member of its own; q/x sits beside; the root is a member. */
  const nested = graphOf({
    '': { name: 'top' },
    'p/a': { name: 'a' },
    'p/a/inner': { name: 'inner' },
    'p/b': { name: 'b' },
    'q/x': { name: 'x' },
  });
  const options = { allowEmpty: true };
  const select = (text: string, legacyDirFiltering = false, cwd = '') =>
    selectMembers(
      nested,
      [
        parseFilter(text, {
          cwd,
          limits: DEFAULT_WORKSPACE_LIMITS,
          legacyDirFiltering,
        }),
      ],
      options,
    ).selected;

  // pnpm 10.28.0 with its default use-glob-dir-filtering, run over this very
  // shape (test/fixtures/workspace-filter-oracle.json holds the whole battery).
  it('without a wildcard names one directory: a member there, and nothing below it', () => {
    expect(select('./p/a')).toEqual(['p/a']);
    expect(select('{p/a}')).toEqual(['p/a']);
    expect(select('./p/a/')).toEqual(['p/a']);
    expect(select('./p/a/inner')).toEqual(['p/a/inner']);
    expect(select('.')).toEqual(['']);
  });

  it('selects nothing when the directory holds no member, whatever lies below it', () => {
    expect(select('./p')).toEqual([]);
    expect(select('{p}')).toEqual([]);
    expect(select('./q')).toEqual([]);
  });

  it('with a wildcard selects the members whose directories match', () => {
    expect(select('./p/*')).toEqual(['p/a', 'p/b']);
    expect(select('./p/**')).toEqual(['p/a', 'p/a/inner', 'p/b']);
    expect(select('./p/a/**')).toEqual(['p/a', 'p/a/inner']);
    expect(select('./**')).toEqual(nested.members.map((m) => m.dir));
  });

  it("takes every member at or below it under pnpm's legacy-dir-filtering", () => {
    expect(select('./p', true)).toEqual(['p/a', 'p/a/inner', 'p/b']);
    expect(select('./p/a', true)).toEqual(['p/a', 'p/a/inner']);
    expect(select('{p}', true)).toEqual(['p/a', 'p/a/inner', 'p/b']);
    expect(select('.', true, 'p/a')).toEqual(['p/a', 'p/a/inner']);
    // A wildcard is an ordinary character there, so it names no directory.
    expect(select('./p/*', true)).toEqual([]);
  });

  it('refuses syntax pnpm reads and the model does not, by name', () => {
    for (const text of ['./p/[ab]', '{p/@(a|b)}'])
      expect(
        codeOf(() => parse(text)),
        text,
      ).toBe('WORKSPACE_FILTER_UNSUPPORTED');
    expect(codeOf(() => parse('./p/{a,b}'))).toBe('WORKSPACE_FILTER_INVALID');
  });
});

describe('a filter that matches nothing', () => {
  it('is an error naming the filter, unless the caller says otherwise', () => {
    const run = () => pick('@h/a', 'nothing-like-this');
    expect(codeOf(run)).toBe('WORKSPACE_FILTER_NO_MATCH');
    expect(run).toThrowError(
      'No workspace member matches the filter "nothing-like-this"',
    );
    const lenient = selectMembers(
      graph,
      [parse('@h/a'), parse('nothing-like-this')],
      {
        allowEmpty: true,
      },
    );
    expect(names(lenient.selected)).toEqual(['@h/a']);
    expect(lenient.unmatched).toEqual(['nothing-like-this']);
  });

  it('is not an error for a ! that takes away nothing', () => {
    expect(names(pick('@h/a', '!nothing-like-this'))).toEqual(['@h/a']);
  });

  it('is an error when the exclusions take everything away', () => {
    expect(codeOf(() => pick('@h/a', '!@h/a'))).toBe(
      'WORKSPACE_FILTER_NO_MATCH',
    );
  });
});

describe('npm -w', () => {
  const select = (args: string[], cwd = '', includeRoot = false) =>
    selectNpmWorkspaces(graph, args, { cwd, includeRoot });

  it('takes a member by name, by directory, and by the directory above it', () => {
    expect(select(['@h/a'])).toEqual(['packages/a']);
    expect(select(['packages/a'])).toEqual(['packages/a']);
    expect(select(['./packages/a'])).toEqual(['packages/a']);
    expect(select(['packages'])).toEqual([
      'packages/a',
      'packages/b',
      'packages/c',
      'packages/d',
      'packages/e',
    ]);
    expect(select(['tools'])).toEqual(['tools/site']);
    expect(select(['../packages/c'], 'tools')).toEqual(['packages/c']);
  });

  it('takes every member with no argument, and the root only when asked', () => {
    expect(select([])).not.toContain('');
    expect(select([], '', true)).toContain('');
  });

  it('refuses a list that selects nothing, as npm does', () => {
    const run = () => select(['nope', 'nothing']);
    expect(codeOf(run)).toBe('WORKSPACE_FILTER_NO_MATCH');
    expect(run).toThrowError(
      'No workspaces found: --workspace=nope --workspace=nothing',
    );
  });
});
