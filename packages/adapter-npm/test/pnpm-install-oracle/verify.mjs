// Does Node find, from every importer and every installed package, the package the lock names? (ADR 0055 section 12)
// usage: node verify.mjs <projectRoot> <plan.json> <edges.json> <plan|disk>
//   plan.json  from plan.mjs;   edges.json  from `python3 dump-edges.py pnpm-lock.yaml` (PyYAML, none of opm's reader)
//   plan: Node's lookup is walked over the planned directories;  disk: over the installed tree, with Node's own
//   require.resolve.paths and the package.json at the place found.
// Exit 0 only with 0 mismatches.
import { readFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [root, planFile, edgesFile, mode] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const edges = JSON.parse(readFileSync(edgesFile, 'utf8'));
const disk = mode === 'disk';

const keyName = (key) => key.split('(')[0].replace(/@[^@]*$/u, '');
const keyVersion = (key) => key.split('(')[0].slice(keyName(key).length + 1);

// --- the tree: planned (a set of directories), or on disk
const placed = new Map(); // abs dir -> instance key
for (const p of plan.packages)
  placed.set(join(root, ...p.path.split('/')), p.instance);
const links = new Map(); // abs dir -> member abs dir
for (const l of plan.links) {
  const dir = join(root, ...l.path.split('/'));
  links.set(dir, resolve(dirname(dir), l.target));
}
const instances = new Set(plan.packages.map((p) => p.instance));

/** Node's lookup: every ancestor directory's node_modules, nearest first. */
function lookup(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (disk) {
      if (existsSync(join(candidate, 'package.json')))
        return { dir: candidate };
    } else if (placed.has(candidate) || links.has(candidate))
      return { dir: candidate };
    if (dir === dirname(dir) || dir === dirname(root)) return undefined;
  }
}
// On disk, Node's own lookup paths are used as well.
function nodeLookup(fromDir, name) {
  const req = createRequire(join(fromDir, 'x.js'));
  for (const base of req.resolve.paths(name) ?? []) {
    const candidate = join(base, ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return { dir: candidate };
  }
  return undefined;
}

let checked = 0,
  skipped = 0;
const mismatches = [];
const fail = (msg) => mismatches.push(msg);

function expectDep(label, fromDir, as, kind, target) {
  if (kind === 'link') {
    const memberDir = resolve(fromDir, target);
    const hit = lookup(fromDir, as);
    checked++;
    if (hit === undefined)
      return fail(`${label}: ${as} (link ${target}) not found`);
    const real = disk ? realpathSync(hit.dir) : links.get(hit.dir);
    const wanted = disk ? realpathSync(memberDir) : memberDir;
    if (real !== wanted)
      fail(`${label}: ${as} is ${real}, the lock links ${wanted}`);
    return;
  }
  if (!instances.has(target)) {
    // not installed on this machine: an optional edge to a platform package, or outside the selection
    skipped++;
    return;
  }
  checked++;
  const hit = lookup(fromDir, as);
  if (hit === undefined) return fail(`${label}: ${as} -> ${target} not found`);
  if (disk) {
    const viaNode = nodeLookup(fromDir, as);
    if (viaNode === undefined || viaNode.dir !== hit.dir)
      fail(
        `${label}: Node's lookup paths find ${viaNode?.dir}, the walk ${hit.dir}`,
      );
    const pj = JSON.parse(readFileSync(join(hit.dir, 'package.json'), 'utf8'));
    if (pj.name !== keyName(target) || pj.version !== keyVersion(target))
      fail(
        `${label}: ${as} is ${pj.name}@${pj.version}, the lock says ${target}`,
      );
  }
  const got = placed.get(hit.dir);
  if (got !== target)
    fail(
      `${label}: ${as} found at ${hit.dir} which is the instance ${got}, the lock says ${target}`,
    );
}

// importers
const installedMembers = new Set(plan.members);
const memberSet = new Set(['.', ...installedMembers]);
for (const [id, list] of Object.entries(edges.importers)) {
  if (
    plan.members.length + 1 < Object.keys(edges.importers).length &&
    id !== '.' &&
    !installedMembers.has(id)
  )
    continue;
  if (id === '.' && plan.packages.length > 0 && plan.rootNotInstalled) continue;
  const dir = id === '.' ? root : join(root, ...id.split('/'));
  for (const [as, , kind, target] of list) {
    if (
      kind === 'link' &&
      !memberSet.has(
        resolve(dir, target) === root
          ? '.'
          : resolve(dir, target).slice(root.length + 1),
      )
    ) {
      skipped++;
      continue;
    }
    expectDep(`importer ${id}`, dir, as, kind, target);
  }
}
// installed instances
for (const [dir, key] of placed) {
  for (const [as, kind, target] of edges.snapshots[key]) {
    expectDep(`${key} at ${dir.slice(root.length + 1)}`, dir, as, kind, target);
  }
  if (disk) {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pj.name !== keyName(key) || pj.version !== keyVersion(key))
      fail(
        `place ${dir}: holds ${pj.name}@${pj.version}, the plan says ${key}`,
      );
  }
}
// disk: nothing else under any node_modules
let extra = 0;
if (disk) {
  const known = new Set([...placed.keys(), ...links.keys()]);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // Dot entries are not packages: .bin, opm's record, and the caches tools leave (.cache, .vite).
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.name.startsWith('@') && e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!known.has(p)) {
        extra++;
        if (extra < 5) fail(`unplanned entry ${p}`);
        continue;
      }
      if (links.has(p)) continue;
      const inner = join(p, 'node_modules');
      if (existsSync(inner)) walk(inner);
    }
  };
  const tops = [
    root,
    ...plan.memberDirs.map((d) => join(root, ...d.split('/'))),
  ];
  for (const t of tops)
    if (existsSync(join(t, 'node_modules'))) walk(join(t, 'node_modules'));
}
console.log(
  JSON.stringify(
    {
      mode,
      places: plan.packages.length,
      instances: instances.size,
      edgesChecked: checked,
      edgesSkippedNotInstalled: skipped,
      unplannedEntries: extra,
      mismatches: mismatches.length,
    },
    null,
    1,
  ),
);
for (const m of mismatches.slice(0, 15)) console.log('MISMATCH', m);
process.exit(mismatches.length === 0 ? 0 : 1);
