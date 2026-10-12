import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CWDS,
  MEMBERS,
  NAME_SELECTORS,
  PATTERNS,
  combinations,
} from './filter-battery.mjs';
import { PINNED, pnpmRunner, scratchDirectory, writeTree } from './tools.mjs';

/** How many random combinations of selectors the golden file holds. */
const COMBINATIONS = 120;

function treeOf() {
  const files = {
    'pnpm-workspace.yaml': `packages:\n${PATTERNS.map((pattern) => `  - ${JSON.stringify(pattern)}\n`).join('')}`,
  };
  for (const [dir, manifest] of Object.entries(MEMBERS))
    files[dir === '' ? 'package.json' : `${dir}/package.json`] = manifest;
  return files;
}

/** Every case: where the command ran, the selectors, and whether pnpm's legacy directory filtering was on. */
export function filterCases() {
  const cases = [];
  for (const { cwd, forms } of CWDS)
    for (const form of forms) {
      cases.push({ cwd, filters: [form], legacy: false });
      cases.push({ cwd, filters: [form], legacy: true });
      if (!/[{}]/u.test(form)) {
        cases.push({ cwd, filters: [`{${form}}`], legacy: false });
        cases.push({ cwd, filters: [`{${form}}`], legacy: true });
      }
    }
  for (const selector of NAME_SELECTORS)
    cases.push({ cwd: '', filters: [selector], legacy: false });
  for (const filters of combinations(COMBINATIONS))
    cases.push({ cwd: '', filters, legacy: false });
  return cases;
}

/** The members `pnpm --filter ... ls` selects for one case, relative to the workspace root, sorted. */
function select(run, root, entry) {
  const args = [
    ...entry.filters.map((filter) => `--filter=${filter}`),
    'ls',
    '--depth',
    '-1',
    '--json',
  ];
  // `legacy-dir-filtering` is a config setting, not an option of `ls`.
  const settings = entry.legacy
    ? { npm_config_legacy_dir_filtering: 'true' }
    : {};
  const result = run(args, join(root, entry.cwd), settings);
  if (result.status !== 0)
    return {
      error: `pnpm exited ${result.status}`,
      message: result.stderr.slice(0, 160),
    };
  const text = result.stdout.trim();
  const projects = text === '' ? [] : JSON.parse(text);
  return {
    selected: projects.map((project) => relative(root, project.path)).sort(),
  };
}

/** The content of workspace-filter-oracle.json: the real pnpm CLI over every case. */
export function filterOracle(tools) {
  const root = realpathSync(scratchDirectory('opm-oracle-filter-'));
  writeTree(root, treeOf());
  const run = pnpmRunner(tools.pnpmBinary);
  return {
    generatedWith: {
      pnpm: `pnpm ${PINNED.pnpm}: \`pnpm --filter=<selector> ... ls --depth -1 --json\` run in the directory named by cwd, with the setting legacy-dir-filtering on (npm_config_legacy_dir_filtering=true) where legacy is true; the root is a member and ls does not leave it out`,
    },
    patterns: PATTERNS,
    members: MEMBERS,
    cases: filterCases().map((entry) => ({
      ...entry,
      ...select(run, root, entry),
    })),
  };
}

export const oracle = {
  name: 'filter',
  file: new URL('../workspace-filter-oracle.json', import.meta.url),
  generate: (tools) => filterOracle(tools),
};
