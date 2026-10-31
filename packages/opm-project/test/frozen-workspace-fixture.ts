/**
 * Shared set-up for the workspace suites of `installFrozen`
 * (`frozen-install.workspace*.test.ts`): a workspace on disk, its lock, and a
 * registry stand-in that serves the lock's packages.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { it } from 'vitest';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { packTarGzip } from '@openpacker/project-io';
import { installFrozen, type FrozenInstallInput } from '../src/index.js';

/** Directories a test made; `cleanup` (an `afterEach`) removes them. */
export const temps: string[] = [];
export async function cleanup(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export const ORIGIN = 'https://registry.npmjs.org';

export interface Pkg {
  name: string;
  version: string;
  files?: Record<string, string>;
  manifest?: Record<string, unknown>;
}

export function tarballOf(pkg: Pkg): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      ...pkg.manifest,
    }),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  return packTarGzip(
    Object.entries(files).map(([path, text]) => ({
      path: `package/${path}`,
      contents: new TextEncoder().encode(text),
      executable: path.startsWith('bin/'),
    })),
  );
}

export class FakeRegistry implements HttpTransport {
  readonly requests: string[] = [];
  readonly archives = new Map<string, Uint8Array>();
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request.url);
    const body = this.archives.get(request.url);
    if (body === undefined)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `no archive at ${request.url}`,
      );
    return { status: 200, headers: {}, body, url: request.url };
  }
}

export const sri = (bytes: Uint8Array) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A workspace on disk, its lock, and a registry that serves the lock's packages. */
export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-ws-'));
  temps.push(dir, `${dir}-store`);
  const registry = new FakeRegistry();
  const members = new Map<string, Record<string, unknown>>();
  const lockEntries: Record<string, unknown> = {};
  const rootManifest: Record<string, unknown> = {
    name: 'app',
    version: '1.0.0',
    workspaces: ['packages/*'],
  };
  const urlOf = (pkg: Pkg) =>
    `${ORIGIN}/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`;
  const world = {
    dir,
    registry,
    root: rootManifest,
    /** A registry package in the lock at `path`. */
    place(path: string, pkg: Pkg, extra: Record<string, unknown> = {}) {
      const bytes = tarballOf(pkg);
      registry.archives.set(urlOf(pkg), bytes);
      lockEntries[path] = {
        version: pkg.version,
        resolved: urlOf(pkg),
        integrity: sri(bytes),
        ...extra,
      };
    },
    /** A member: its directory, its manifest, and its link, as npm writes them. */
    member(
      name: string,
      manifest: Record<string, unknown> = {},
      options: { dir?: string; link?: boolean } = {},
    ) {
      const memberDir = options.dir ?? `packages/${name.split('/').at(-1)}`;
      const record = { name, version: '1.0.0', main: 'index.js', ...manifest };
      members.set(memberDir, record);
      if (options.link !== false)
        lockEntries[`node_modules/${name}`] = {
          resolved: memberDir,
          link: true,
        };
      return memberDir;
    },
    raw(path: string, entry: unknown) {
      lockEntries[path] = entry;
    },
    /** Write the project: member sources, the root manifest, the lock. */
    async write(
      options: { lockMembers?: Record<string, Record<string, unknown>> } = {},
    ) {
      for (const [memberDir, record] of members) {
        await mkdir(join(dir, memberDir), { recursive: true });
        await writeFile(
          join(dir, memberDir, 'package.json'),
          JSON.stringify(record),
        );
        await writeFile(
          join(dir, memberDir, 'index.js'),
          `module.exports = ${JSON.stringify(`member ${String(record.name)}`)};\n`,
        );
      }
      await writeFile(join(dir, 'package.json'), JSON.stringify(rootManifest));
      const recorded = options.lockMembers ?? Object.fromEntries(members);
      await writeFile(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': rootManifest, ...recorded, ...lockEntries },
        }),
      );
    },
    install(extra: Partial<FrozenInstallInput> = {}) {
      return installFrozen({
        root: dir,
        transport: registry,
        env: { OPM_STORE_HOME: join(dir, '..', `${basename(dir)}-store`) },
        now: () => '2026-10-12T12:00:00.000Z',
        ...extra,
      });
    },
    run(script: string, from = ''): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: join(dir, from),
        encoding: 'utf8',
      }).trim();
    },
    read: (path: string) => readFile(join(dir, path), 'utf8'),
    list: (path: string) =>
      readdir(join(dir, path)).then((names) => names.sort()),
    async isLink(path: string) {
      return (await lstat(join(dir, path))).isSymbolicLink();
    },
  };
  return world;
}

/** Shims are run through `sh`; links are junctions with absolute text on Windows. */
export const onPosix = it.skipIf(process.platform === 'win32');

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A workspace of two members, each wanting a version of `left`; `one` needs `two`. */
export async function standard(
  extra: (w: Awaited<ReturnType<typeof setup>>) => void = () => {},
) {
  const w = await setup();
  w.root.dependencies = { a: '^1.0.0', left: '^1.0.0' };
  w.root.devDependencies = { t: '^1.0.0' };
  w.place('node_modules/a', { name: 'a', version: '1.0.0' });
  w.place('node_modules/t', { name: 't', version: '1.0.0' }, { dev: true });
  w.place('node_modules/left', { name: 'left', version: '1.0.0' });
  w.place('packages/one/node_modules/left', { name: 'left', version: '0.9.0' });
  w.place('node_modules/b', { name: 'b', version: '1.0.0' });
  w.place('node_modules/dd', { name: 'dd', version: '1.0.0' }, { dev: true });
  w.member('one', {
    dependencies: { left: '^0.9.0', two: '^1.0.0', a: '^1.0.0' },
    scripts: {
      postinstall: "node -e \"require('fs').writeFileSync('ran','x')\"",
    },
  });
  w.member('two', {
    dependencies: { b: '^1.0.0' },
    devDependencies: { dd: '^1.0.0' },
    bin: { two: 'bin/two.js' },
  });
  extra(w);
  return w;
}

export type World = Awaited<ReturnType<typeof setup>>;

/** The names of the packages a store holds the files of. */
export async function storedNames(store: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(store)) {
    if (!/^sha256-[0-9a-f]{64}$/u.test(entry)) continue;
    const manifest = JSON.parse(
      await readFile(join(store, entry, 'package', 'package.json'), 'utf8'),
    ) as { name: string };
    names.push(manifest.name);
  }
  return names.sort();
}
