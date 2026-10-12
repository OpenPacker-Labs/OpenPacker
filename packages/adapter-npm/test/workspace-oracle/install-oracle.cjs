#!/usr/bin/env node
/*
 * What `npm ci` would install for a workspace, read from npm's own arborist,
 * compared with the tree a project's node_modules actually holds.
 *
 * Read-only on both sides: the lock is read with `loadVirtual` (nothing is
 * fetched or written) and the project is walked, not changed. The rules that
 * decide what is left out are npm's: `checkPlatform` from npm-install-checks,
 * arborist's `optionalSet`, the `omit` test of reify, and the filter set
 * `Diff.calculate` builds for `--workspace` (see docs/adr/0051).
 *
 *   node install-oracle.cjs <projectDir> [--omit dev,optional,peer]
 *        [--workspace a,b] [--include-workspace-root] [--no-workspaces]
 *
 * NPM_MODULES names the node_modules directory that holds npm's packages
 * (default: the one beside the node that runs this). Exit status 0 when the
 * installed set equals the expected one, 1 when it does not.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const npmModules =
  process.env.NPM_MODULES ||
  path.join(
    path.dirname(path.dirname(process.execPath)),
    'lib/node_modules/npm/node_modules',
  );
const Arborist = require(path.join(npmModules, '@npmcli/arborist'));
const optionalSetOf = require(
  path.join(npmModules, '@npmcli/arborist/lib/optional-set.js'),
);
const { checkPlatform } = require(path.join(npmModules, 'npm-install-checks'));

function parse(argv) {
  const out = {
    dir: undefined,
    omit: new Set(),
    workspaces: [],
    includeRoot: false,
    noWorkspaces: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--omit') argv[++i].split(',').forEach((k) => out.omit.add(k));
    else if (arg === '--workspace')
      out.workspaces.push(...argv[++i].split(','));
    else if (arg === '--include-workspace-root') out.includeRoot = true;
    else if (arg === '--no-workspaces') out.noWorkspaces = true;
    else out.dir = path.resolve(arg);
  }
  return out;
}

const describe = (node) =>
  node.isLink
    ? `${node.location}|${node.name}|${node.target.version}|-> ${node.target.location}`
    : `${node.location}|${node.packageName}|${node.version}|`;

/** Arborist's filter for --workspace, as Diff.calculate builds it from the ideal tree. */
function filterSet(tree, names, includeRoot) {
  const set = new Set();
  const visit = (start) => {
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (set.has(node)) continue;
      set.add(node);
      set.add(node.target);
      for (const edge of node.target.edgesOut.values())
        if (edge.to) stack.push(edge.to);
    }
  };
  for (const name of names) {
    const link = tree.children.get(name);
    if (link) visit(link);
  }
  if (includeRoot)
    for (const edge of tree.edgesOut.values())
      if (edge.type !== 'workspace' && edge.to) visit(edge.to);
  return set;
}

/** Packages (and links) as a project's node_modules holds them, walked without following links. */
function walkInstalled(projectDir, memberDirs) {
  const found = new Set();
  const rel = (p) => path.relative(projectDir, p).split(path.sep).join('/');
  const modules = (base) => {
    const dir = path.join(base, 'node_modules');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const scoped = name.startsWith('@');
      const entries = scoped
        ? fs.readdirSync(path.join(dir, name)).map((n) => `${name}/${n}`)
        : [name];
      for (const entry of entries) {
        const at = path.join(dir, entry);
        const info = fs.lstatSync(at);
        if (info.isSymbolicLink()) {
          const target = fs.realpathSync(at);
          const manifest = JSON.parse(
            fs.readFileSync(path.join(target, 'package.json'), 'utf8'),
          );
          found.add(
            `${rel(at)}|${entry}|${manifest.version}|-> ${rel(target)}`,
          );
          continue;
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(at, 'package.json'), 'utf8'),
        );
        found.add(`${rel(at)}|${manifest.name}|${manifest.version}|`);
        modules(at);
      }
    }
  };
  modules(projectDir);
  for (const member of memberDirs) modules(path.join(projectDir, member));
  return found;
}

function lookup(projectDir, from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(at, 'package.json')))
      return fs.realpathSync(at);
    if (dir === projectDir || dir === path.dirname(dir)) return undefined;
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const tree = await new Arborist({ path: options.dir }).loadVirtual();
  const inventory = [...tree.inventory.values()].filter((node) => !node.isRoot);
  // A workspace is two nodes: the link in node_modules and the directory it names.
  const members = inventory.filter((node) => node.isWorkspace && !node.isLink);
  const candidates = inventory.filter(
    (node) => node.isLink || !node.isWorkspace,
  );

  // --workspace / --workspaces=false narrow what is considered at all.
  let scope;
  if (options.noWorkspaces) {
    scope = new Set();
    const visit = (start) => {
      const stack = [start];
      while (stack.length > 0) {
        const node = stack.pop();
        if (scope.has(node)) continue;
        scope.add(node);
        for (const edge of node.target.edgesOut.values())
          if (edge.to) stack.push(edge.to);
      }
    };
    for (const edge of tree.edgesOut.values())
      if (edge.type !== 'workspace' && edge.to) visit(edge.to);
  } else if (options.workspaces.length > 0)
    scope = filterSet(tree, options.workspaces, options.includeRoot);

  const trashed = new Set();
  const refused = [];
  for (const node of candidates) {
    if (node.isLink) continue;
    try {
      checkPlatform(node.package, false, {});
    } catch {
      if (!node.optional) refused.push(describe(node));
      else for (const dropped of optionalSetOf(node)) trashed.add(dropped);
    }
  }
  for (const node of candidates) {
    if (node.isLink) continue;
    if (
      (node.peer && options.omit.has('peer')) ||
      (node.dev && options.omit.has('dev')) ||
      (node.optional && options.omit.has('optional')) ||
      (node.devOptional &&
        options.omit.has('optional') &&
        options.omit.has('dev'))
    )
      trashed.add(node);
  }
  const installed = candidates.filter(
    (node) => !trashed.has(node) && (scope === undefined || scope.has(node)),
  );
  const expected = new Set(installed.map(describe));
  const memberDirs = members.map((node) => node.location);
  const actual = walkInstalled(options.dir, memberDirs);

  const onlyExpected = [...expected].filter((item) => !actual.has(item)).sort();
  const onlyActual = [...actual].filter((item) => !expected.has(item)).sort();

  // From each member, each declared dependency must be found where the lock says.
  const installedNodes = new Set(
    installed.flatMap((node) => [node, node.target]),
  );
  const resolution = {
    checked: 0,
    wrongPlace: [],
    notInstalledAsExpected: [],
    requireResolved: 0,
    requireUnresolvable: 0,
    unresolvableBecause: {},
    requireWrong: [],
  };
  for (const member of members) {
    if (scope !== undefined && !scope.has(member)) continue;
    const memberDir = member.realpath;
    const requireFrom = createRequire(path.join(memberDir, 'noop.js'));
    for (const edge of member.edgesOut.values()) {
      const to = edge.to;
      if (!to) continue;
      const want = to.isLink ? to.target : to;
      const label = `${member.location} -> ${edge.name}`;
      if (!installedNodes.has(to) && !installedNodes.has(want)) {
        const there = lookup(options.dir, memberDir, edge.name);
        if (there !== undefined && !to.isLink)
          resolution.notInstalledAsExpected.push(
            `${label} (expected to be absent, found ${path.relative(options.dir, there)})`,
          );
        continue;
      }
      resolution.checked += 1;
      const found = lookup(options.dir, memberDir, edge.name);
      const expectedReal = fs.existsSync(want.realpath)
        ? fs.realpathSync(want.realpath)
        : want.realpath;
      if (found !== expectedReal) {
        resolution.wrongPlace.push(
          `${label}: lock says ${path.relative(options.dir, expectedReal)}, found ${found && path.relative(options.dir, found)}`,
        );
        continue;
      }
      try {
        const file = fs.realpathSync(requireFrom.resolve(edge.name));
        if (file.startsWith(expectedReal + path.sep))
          resolution.requireResolved += 1;
        else resolution.requireWrong.push(`${label}: ${file}`);
      } catch (error) {
        // Not a fault of the install: a member not built yet has no main file,
        // and a package that exports only an import condition has no require entry.
        resolution.requireUnresolvable += 1;
        const why = `${error.code}${to.isLink ? ' (member)' : ''}`;
        resolution.unresolvableBecause[why] =
          (resolution.unresolvableBecause[why] ?? 0) + 1;
      }
    }
  }

  const report = {
    lockEntries: inventory.length,
    members: members.length,
    expected: expected.size,
    installed: actual.size,
    refusedByPlatform: refused,
    onlyExpected,
    onlyActual,
    resolution,
    equal:
      onlyExpected.length === 0 &&
      onlyActual.length === 0 &&
      refused.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exit(
    report.equal &&
      resolution.wrongPlace.length === 0 &&
      resolution.requireWrong.length === 0
      ? 0
      : 1,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(2);
});
