// The places `opm ci` would give a pnpm project (ADR 0055), as JSON, for verify.mjs. Reads, plans, writes only <out.json>.
// usage: node plan.mjs <projectRoot> <out.json> [--filter sel]... [--include-root] [--arch project] [--omit dev]
// Run after `npm run build` (it imports the packages' dist).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const packages = (name) =>
  new URL(`../../../${name}/dist/esm/`, import.meta.url);
const load = (name, file) =>
  import(fileURLToPath(new URL(file, packages(name))));
const adapter = await load('adapter-npm', 'pnpm-install/frozen.js');
const core = await load('adapter-core', 'index.js');
const project = await load('opm-project', 'index.js');
const [root, out, ...rest] = process.argv.slice(2);
const filters = [];
let includeRoot = false,
  arch,
  omit = new Set();
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--filter') filters.push(rest[++i]);
  else if (rest[i] === '--include-root') includeRoot = true;
  else if (rest[i] === '--arch') arch = rest[++i];
  else if (rest[i] === '--omit') omit.add(rest[++i]);
}
const discovery = await project.discoverWorkspace(root, { tool: 'pnpm' });
let scope = { kind: 'all' };
if (filters.length > 0) {
  const graph = project.graphOfWorkspace(discovery);
  const selectors = filters.map((f) =>
    core.parseFilter(f, { cwd: '', limits: core.resolveWorkspaceLimits() }),
  );
  const dirs = core.selectMembers(graph, selectors, {
    excludeRoot: !includeRoot,
  }).selected;
  scope = { kind: 'members', dirs, includeRoot };
}
const lock = await adapter.readFrozenPnpmLock(
  { root, manifestPath: root + '/package.json' },
  {
    target: core.detectNativeTarget(),
    omit,
    ...(arch && { architectures: arch }),
    workspace: { disk: async () => discovery?.members ?? [], scope },
  },
  root + '/pnpm-lock.yaml',
);
writeFileSync(
  out,
  JSON.stringify({
    lockPath: lock.lockPath,
    rootNotInstalled: filters.length > 0 && !includeRoot,
    refused: lock.refused,
    targets: lock.targets,
    packages: lock.packages.map((p) => ({
      path: p.path,
      instance: p.instance,
      name: p.name,
      packageName: p.packageName,
      version: p.version,
      integrity: p.integrity,
      direct: p.direct,
    })),
    skipped: lock.skipped.map((s) => ({ key: s.path, kind: s.kind })),
    members: lock.workspace?.layout.members.map((m) => m.dir) ?? [],
    memberDirs: lock.workspace?.memberDirs ?? [],
    links: lock.workspace?.layout.links ?? [],
  }),
);
console.log(
  'plan written:',
  lock.packages.length,
  'places,',
  new Set(lock.packages.map((p) => p.instance)).size,
  'instances,',
  lock.workspace?.layout.members.length ?? 0,
  'members,',
  lock.workspace?.layout.links.length ?? 0,
  'links',
);
