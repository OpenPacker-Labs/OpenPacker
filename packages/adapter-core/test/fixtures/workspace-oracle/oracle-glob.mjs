import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { BARE, MANIFESTS, PATTERN_LISTS } from './glob-battery.mjs';
import {
  PINNED,
  listedDirectories,
  pnpmRunner,
  scratchDirectory,
  writeTree,
} from './tools.mjs';

/** The tree every pattern list is run over: a name for each manifest, none for a bare directory. */
function treeOf() {
  const files = {};
  for (const dir of MANIFESTS)
    files[dir === '' ? 'package.json' : `${dir}/package.json`] = {
      name: dir === '' ? 'root' : dir.replaceAll('/', '+'),
    };
  for (const dir of BARE) files[dir] = null;
  return files;
}

/** The text of a pnpm-workspace.yaml whose `packages` are the patterns (JSON strings are YAML strings). */
function workspaceFile(patterns) {
  if (patterns.length === 0) return 'packages: []\n';
  return `packages:\n${patterns.map((pattern) => `  - ${JSON.stringify(pattern)}\n`).join('')}`;
}

function failure(error) {
  return {
    error: error.code ?? error.name,
    message: String(error.message).slice(0, 120),
  };
}

/**
 * Ask pnpm: `pnpm ls -r` over a workspace file lists the projects its
 * `findPackages` (the tinyglobby it bundles) found, the root always among them.
 */
function pnpmMembers(run, root, patterns, writeWorkspaceFile) {
  writeWorkspaceFile(workspaceFile(patterns));
  const listed = listedDirectories(
    run(['ls', '-r', '--depth', '-1', '--json'], root),
    realpathSync(root),
  );
  return listed;
}

/** Ask npm: `@npmcli/map-workspaces`, which arborist and `npm -w` use. */
async function npmMembers(mapWorkspaces, root, workspaces) {
  const found = await mapWorkspaces({ cwd: root, pkg: { workspaces } });
  return [...found.values()]
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort();
}

/**
 * Both tools over every pattern list. `lists` defaults to the battery; the
 * result is the content of workspace-glob-oracle.json.
 */
export async function globOracle(tools, lists = PATTERN_LISTS) {
  const root = scratchDirectory('opm-oracle-glob-');
  writeTree(root, treeOf());
  const run = pnpmRunner(tools.pnpmBinary);
  const writeWorkspaceFile = (text) =>
    writeTree(root, { 'pnpm-workspace.yaml': text });
  const cases = [];
  for (const patterns of lists) {
    const entry = { patterns };
    try {
      entry.pnpm = pnpmMembers(run, root, patterns, writeWorkspaceFile);
    } catch (error) {
      entry.pnpm = failure(error);
    }
    try {
      entry.npm = await npmMembers(tools.mapWorkspaces, root, patterns);
    } catch (error) {
      entry.npm = failure(error);
    }
    cases.push(entry);
  }
  return {
    generatedWith: {
      pnpm: `pnpm ${PINNED.pnpm}: \`pnpm ls -r --depth -1 --json\` over a pnpm-workspace.yaml holding the patterns, so findPackages with the tinyglobby 0.2.14 bundled in pnpm.cjs, the root always included, node_modules and bower_components ignored`,
      npm: `npm ${PINNED.npm}: @npmcli/map-workspaces ${PINNED.mapWorkspaces} with glob ${PINNED.glob}`,
    },
    manifests: MANIFESTS,
    bare: BARE,
    cases,
  };
}

export const oracle = {
  name: 'glob',
  file: new URL('../workspace-glob-oracle.json', import.meta.url),
  generate: (tools) => globOracle(tools),
};
