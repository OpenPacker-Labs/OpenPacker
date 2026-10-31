/**
 * Shared set-up for the suites of `installFrozen` over a `pnpm-lock.yaml`
 * (`frozen-install.pnpm*.test.ts`): a workspace on disk with its importers'
 * manifests, the lock that goes with them, and a registry stand-in that serves
 * the packages.
 *
 * Every package's `index.js` reports what it is (its name and version: the
 * archive of a package is the same whatever peers a snapshot was resolved
 * against) and the version of each of its dependencies *as Node resolves it from where the package is installed*, so a
 * test that requires a package from an importer reads what the layout gave it,
 * not what a model says it should have.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { installFrozen, type FrozenInstallInput } from '../src/index.js';
import {
  FakeRegistry,
  ORIGIN,
  cleanup,
  sri,
  tarballOf,
  temps,
} from './frozen-workspace-fixture.js';

export { cleanup };

/** A dependency of an importer: the specifier in `package.json` and the version in the lock. */
export type Spec = readonly [specifier: string, version: string];

export interface PnpmPkg {
  name: string;
  version: string;
  /** The peer suffix of the snapshot: `(react@18.2.0)`. */
  suffix?: string;
  /** Edges of the snapshot: install name to the lock's value (`1.0.0`, or `name@1.0.0` for an alias). */
  deps?: Record<string, string>;
  optionalDeps?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /** The snapshot's `optional` flag. */
  optional?: boolean;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
  /** Replaces the integrity the lock records. */
  integrity?: string;
  /** Written into the `packages` entry as is, after `resolution`. */
  extraPackageLines?: string[];
}

export interface ImporterLists {
  dependencies?: Record<string, Spec>;
  devDependencies?: Record<string, Spec>;
  optionalDependencies?: Record<string, Spec>;
}

const q = (text: string): string => JSON.stringify(text);

function reporter(pkg: PnpmPkg): string {
  const names = Object.keys({ ...pkg.deps, ...pkg.optionalDeps });
  return (
    `const deps = {};\nfor (const n of ${JSON.stringify(names)}) {\n` +
    `  try { deps[n] = require(n + '/package.json').version; } catch { deps[n] = null; }\n}\n` +
    `module.exports = { id: ${q(`${pkg.name}@${pkg.version}`)}, deps };\n`
  );
}

/** A pnpm workspace on disk, its lock, and a registry that serves its packages. */
export async function pnpmWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-pnpm-'));
  temps.push(dir, `${dir}-store`);
  const registry = new FakeRegistry();
  const packages = new Map<string, PnpmPkg>();
  const importers = new Map<
    string,
    { name: string; lists: ImporterLists; manifest: Record<string, unknown> }
  >();
  const extraRoot: string[] = [];
  const extraLock: string[] = [];

  const snapshotKey = (pkg: PnpmPkg) =>
    `${pkg.name}@${pkg.version}${pkg.suffix ?? ''}`;

  const lockText = (): string => {
    const out: string[] = [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      ...extraRoot,
      'importers:',
      '',
    ];
    for (const [id, { lists }] of [...importers].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      out.push(`  ${q(id)}:`);
      const present = (
        ['dependencies', 'devDependencies', 'optionalDependencies'] as const
      ).filter((field) => Object.keys(lists[field] ?? {}).length > 0);
      if (present.length === 0) out[out.length - 1] += ' {}';
      for (const field of present) {
        out.push(`    ${field}:`);
        for (const [name, [specifier, version]] of Object.entries(
          lists[field]!,
        ).sort(([a], [b]) => (a < b ? -1 : 1))) {
          out.push(
            `      ${q(name)}:`,
            `        specifier: ${q(specifier)}`,
            `        version: ${q(version)}`,
          );
        }
      }
    }
    out.push('', 'packages:', '');
    const byPackage = new Map<string, PnpmPkg>();
    for (const pkg of packages.values())
      byPackage.set(`${pkg.name}@${pkg.version}`, pkg);
    for (const [key, pkg] of [...byPackage].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const bytes = tarballOf({
        ...pkg,
        files: { 'index.js': reporter(pkg), ...pkg.files },
      });
      registry.archives.set(
        `${ORIGIN}/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`,
        bytes,
      );
      out.push(
        `  ${q(key)}:`,
        `    resolution: {integrity: ${pkg.integrity ?? sri(bytes)}}`,
      );
      if (pkg.cpu) out.push(`    cpu: ${JSON.stringify(pkg.cpu)}`);
      if (pkg.libc) out.push(`    libc: ${JSON.stringify(pkg.libc)}`);
      if (pkg.os) out.push(`    os: ${JSON.stringify(pkg.os)}`);
      out.push(...(pkg.extraPackageLines ?? []), '');
    }
    out.push('snapshots:', '');
    for (const pkg of [...packages.values()].sort((a, b) =>
      snapshotKey(a) < snapshotKey(b) ? -1 : 1,
    )) {
      const lines: string[] = [];
      for (const field of ['deps', 'optionalDeps'] as const) {
        const list = pkg[field] ?? {};
        if (Object.keys(list).length === 0) continue;
        lines.push(
          `    ${field === 'deps' ? 'dependencies' : 'optionalDependencies'}:`,
          ...Object.entries(list)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, value]) => `      ${q(name)}: ${q(value)}`),
        );
      }
      if (pkg.optional) lines.push('    optional: true');
      out.push(
        `  ${q(snapshotKey(pkg))}:${lines.length === 0 ? ' {}' : ''}`,
        ...lines,
        '',
      );
    }
    out.push(...extraLock);
    return `${out.join('\n')}\n`;
  };

  const world = {
    dir,
    registry,
    packages,
    /** A snapshot, with its package. */
    pkg(spec: PnpmPkg): PnpmPkg {
      packages.set(snapshotKey(spec), spec);
      return spec;
    },
    /** An importer: its directory (`.` for the project), name and dependency lists. */
    importer(
      id: string,
      lists: ImporterLists = {},
      manifest: Record<string, unknown> = {},
    ): void {
      importers.set(id, {
        name:
          (manifest.name as string | undefined) ??
          (id === '.' ? 'app' : id.split('/').at(-1)!),
        lists,
        manifest,
      });
    },
    /** Text written into the lock before `importers:` (overrides, catalogs). */
    rootLines(...lines: string[]): void {
      extraRoot.push(...lines);
    },
    /** Text written after the snapshots. */
    tailLines(...lines: string[]): void {
      extraLock.push(...lines);
    },
    lockText,
    /** Write the project: every importer's manifest, `pnpm-workspace.yaml`, the lock. */
    async write(
      options: { workspaceYaml?: string; lock?: string } = {},
    ): Promise<void> {
      const members = [...importers.keys()].filter((id) => id !== '.');
      for (const [id, { name, lists, manifest }] of importers) {
        const at = id === '.' ? dir : join(dir, id);
        await mkdir(at, { recursive: true });
        const field = (list: Record<string, Spec> | undefined) =>
          list === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(list).map(([n, [specifier]]) => [n, specifier]),
              );
        const record: Record<string, unknown> = {
          name,
          version: '1.0.0',
          main: 'index.js',
          ...manifest,
          ...(lists.dependencies && {
            dependencies: field(lists.dependencies),
          }),
          ...(lists.devDependencies && {
            devDependencies: field(lists.devDependencies),
          }),
          ...(lists.optionalDependencies && {
            optionalDependencies: field(lists.optionalDependencies),
          }),
        };
        await writeFile(join(at, 'package.json'), JSON.stringify(record));
        if (id !== '.')
          await writeFile(
            join(at, 'index.js'),
            `module.exports = ${JSON.stringify(`member ${name}`)};\n`,
          );
      }
      await writeFile(
        join(dir, 'pnpm-workspace.yaml'),
        options.workspaceYaml ??
          (members.length === 0
            ? ''
            : `packages:\n${[...new Set(members.map((m) => `  - ${q(m.split('/').slice(0, -1).join('/') + '/*')}`))].join('\n')}\n`),
      );
      if (members.length === 0)
        await writeFile(
          join(dir, 'pnpm-workspace.yaml'),
          'packages:\n  - "."\n',
        );
      await writeFile(join(dir, 'pnpm-lock.yaml'), options.lock ?? lockText());
    },
    install(extra: Partial<FrozenInstallInput> = {}) {
      return installFrozen({
        root: dir,
        transport: registry,
        env: { OPM_STORE_HOME: join(dir, '..', `${basename(dir)}-store`) },
        now: () => '2026-10-12T12:00:00.000Z',
        target: { os: 'linux', architecture: 'x64', libc: 'glibc' },
        ...extra,
      });
    },
    /** What `node -e script` prints from `from` (a directory under the project). */
    run(script: string, from = ''): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: join(dir, from),
        encoding: 'utf8',
      }).trim();
    },
    /** `require(name)` from `from`, as JSON. */
    load(
      name: string,
      from = '',
    ): { id: string; deps: Record<string, string | null> } {
      return JSON.parse(
        world.run(`console.log(JSON.stringify(require(${q(name)})))`, from),
      );
    },
    read: (path: string) => readFile(join(dir, path), 'utf8'),
    list: (path: string) => readdir(join(dir, path)).then((n) => n.sort()),
  };
  return world;
}

export type PnpmWorld = Awaited<ReturnType<typeof pnpmWorld>>;
