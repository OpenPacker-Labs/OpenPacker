/**
 * The inputs of the filter oracle: one workspace and the `--filter` selectors
 * pnpm is asked about, from the workspace root and from directories below it.
 */
export const PATTERNS = ['packages/**', 'apps/*', 'tools/*'];

const link = (name) => ({ [name]: 'workspace:*' });

/** a -> b -> c; d reaches b by a devDependency and e by an optional one; x -> a; y -> d. */
export const MEMBERS = {
  '': { name: 'hobo-root', version: '1.0.0', private: true },
  'packages/a': { name: '@h/a', version: '1.0.0', dependencies: link('@h/b') },
  'packages/a/inner': {
    name: '@h/inner',
    version: '1.0.0',
    dependencies: link('@h/c'),
  },
  'packages/b': { name: '@h/b', version: '1.0.0', dependencies: link('@h/c') },
  'packages/c': { name: '@h/c', version: '1.0.0' },
  'packages/d': {
    name: '@h/d',
    version: '1.0.0',
    devDependencies: link('@h/b'),
    optionalDependencies: link('@h/e'),
  },
  'packages/e': { name: '@h/e', version: '1.0.0' },
  'packages/v1.2': { name: 'v1.2', version: '1.0.0' },
  'packages/deep/er/leaf': { name: 'leaf', version: '1.0.0' },
  'apps/x': { name: 'x', version: '1.0.0', dependencies: link('@h/a') },
  'apps/y': { name: 'y-app', version: '1.0.0', dependencies: link('@h/d') },
  'tools/site': { name: 'site', version: '1.0.0', dependencies: link('x') },
};

/** Directory selectors written from the workspace root. */
const FROM_ROOT = [
  '.',
  './',
  '..',
  '../',
  './packages',
  './packages/',
  './packages/a',
  './packages/a/',
  './packages/a/inner',
  './packages/a/inner/',
  './packages/*',
  './packages/*/',
  './packages/**',
  './packages/**/',
  './packages/a/*',
  './packages/a/**',
  './packages/**/leaf',
  './packages/*/inner',
  './packages/a?',
  './packages/?',
  './packages/v1.2',
  './packages/v1.?',
  './packages/v1?2',
  './packages/deep',
  './packages/deep/**',
  './apps',
  './apps/*',
  './apps/**',
  './tools',
  './tools/*',
  './nothing',
  './nothing/*',
  './*',
  './*/*',
  './**',
  './**/*',
  './packages/{a,b}',
  './packages/[ab]',
  './packages/@(a|b)',
  './packages/a,b',
];

/** The same, written from `packages/a` (a member with a member inside it) and from `packages`. */
const FROM_MEMBER = [
  '.',
  './',
  './inner',
  './inner/',
  '..',
  '../b',
  '../*',
  '../**',
  '../../apps/x',
  '../../apps/*',
  './*',
  './**',
  '../..',
  '../../..',
];
const FROM_PACKAGES = [
  '.',
  '..',
  './a',
  './a/',
  './a/inner',
  './*',
  './**',
  './deep/**',
  '../apps',
  '../apps/*',
  '../tools/site',
  '../..',
];
const FROM_APPS = ['.', './x', './*', '../packages/b', '../packages/*'];

export const CWDS = [
  { cwd: '', forms: FROM_ROOT },
  { cwd: 'packages/a', forms: FROM_MEMBER },
  { cwd: 'packages', forms: FROM_PACKAGES },
  { cwd: 'apps', forms: FROM_APPS },
];

/** Selectors by name, with the walks and the exclusion, that no directory is involved in. */
export const NAME_SELECTORS = [
  '@h/a',
  '@h/*',
  '@h/?',
  '@*/a',
  '*',
  'x*',
  '*e',
  '@h/a...',
  '...@h/a',
  '...^@h/a',
  '@h/a^...',
  '...@h/b...',
  '...^@h/b^...',
  '@h/c...',
  '...@h/c',
  '!@h/a',
  '!@h/*',
  '!...@h/c',
  '!@h/a...',
  'a',
  'inner',
  'c',
  'leaf',
  'y-app',
  'x',
  'site...',
  '...site',
  'v1.2',
  'v1.*',
  'nothing',
  'nothing...',
  '...nothing',
  '@h/a{packages/a}',
  '@h/*{packages/*}',
  '@h/*{packages/**}',
  '@h/a{apps}',
  'x{apps/*}',
  '*{apps/*}',
  '*{./apps/*}...',
  '...{apps/x}',
  '{apps/x}...',
  '...^{apps/x}',
  '{apps/x}^...',
  '{packages/a}...',
  '...{packages/a}',
  '...{packages/a/**}',
  '{packages/**}...',
  '{packages/a/**}',
  '{packages/a}',
  '{packages}',
  '{packages/*}',
  '{.}',
  '{./}',
  '!{apps/x}',
  '!{packages/**}',
  '!./apps/*',
  '!./packages',
  '!{packages/a}...',
];

/** A small deterministic generator (a linear congruence on 32 bits), so the combinations are the same on every run. */
function sequence(seed) {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % below;
  };
}

/** Lists of one to three selectors drawn from the pools: the interplay of `...`, `!` and directories. */
export function combinations(count) {
  const pool = [
    ...NAME_SELECTORS,
    ...FROM_ROOT.filter(
      (form) => !form.startsWith('..') && !/[[(,{]/u.test(form),
    ),
  ];
  const next = sequence(20260);
  const lists = [];
  for (let at = 0; at < count; at += 1) {
    const size = 1 + next(3);
    const list = Array.from({ length: size }, () => pool[next(pool.length)]);
    if (list.some((selector) => typeof selector !== 'string'))
      throw new Error('a combination drew no selector');
    lists.push(list);
  }
  return lists;
}
