/**
 * Projects that install the same lock into one shared store, for the suites
 * that run `opm gc --shared` while an install is using that store.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { packTarGzip } from '@openpacker/project-io';
import {
  materializeThroughSharedStore,
  storeKeyFromDigest,
  type FrozenInstallInput,
} from '../src/index.js';
import {
  installFrozenWith,
  type FrozenInstallSeams,
} from '../src/frozen-install.js';

const temps: string[] = [];

/** Remove what the worlds of a test made; an `afterEach`. */
export async function cleanupWorlds(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** A new directory under the system's temporary one, removed after the test. */
export async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const ORIGIN = 'https://registry.npmjs.org';
const NAMES = ['a', 'b'] as const;

function tarballOf(name: string): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name,
      version: '1.0.0',
      main: 'index.js',
    }),
    'index.js': `module.exports = ${JSON.stringify(`${name}@1.0.0`)};\n`,
  };
  return packTarGzip(
    Object.entries(files).map(([path, text]) => ({
      path: `package/${path}`,
      contents: new TextEncoder().encode(text),
    })),
  );
}

/** Serves each package's archive and counts what it was asked for. */
class Registry implements HttpTransport {
  readonly requests: string[] = [];
  readonly archives = new Map<string, Uint8Array>();
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request.url);
    const body = this.archives.get(request.url);
    if (body === undefined)
      throw new ProviderError('ARTIFACT_NOT_FOUND', `no ${request.url}`);
    return { status: 200, headers: {}, body, url: request.url };
  }
}

/** `count` projects locking `a@1.0.0` and `b@1.0.0`, sharing one store. */
export async function world(count: number) {
  const base = await mkdtemp(join(tmpdir(), 'opm-gc-race-'));
  temps.push(base);
  const env = { OPM_STORE_HOME: join(base, 'store') };
  const registry = new Registry();
  const packages: Record<string, unknown> = {};
  for (const name of NAMES) {
    const bytes = tarballOf(name);
    const url = `${ORIGIN}/${name}/-/${name}-1.0.0.tgz`;
    registry.archives.set(url, bytes);
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: url,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
  }
  const manifest = {
    name: 'app',
    version: '1.0.0',
    dependencies: { a: '1.0.0', b: '1.0.0' },
  };
  const dirs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const dir = join(base, `project-${index}`);
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': manifest, ...packages },
      }),
    );
    dirs.push(dir);
  }
  return {
    env,
    store: env.OPM_STORE_HOME,
    registry,
    dirs,
    install(
      index: number,
      extra: Partial<FrozenInstallInput> = {},
      seams: FrozenInstallSeams = {},
    ) {
      return installFrozenWith(
        {
          root: dirs[index]!,
          transport: registry,
          env,
          now: () => '2026-10-17T12:00:00.000Z',
          ...extra,
        },
        seams,
      );
    },
    /** What `require(name)` gives in project `index`. */
    require(index: number, name: string): string {
      return execFileSync(
        process.execPath,
        ['-e', `process.stdout.write(require(${JSON.stringify(name)}))`],
        { cwd: dirs[index]!, encoding: 'utf8' },
      );
    },
    /** Nothing links the store's entries any more. */
    async unlink(index: number): Promise<void> {
      await rm(join(dirs[index]!, 'node_modules'), { recursive: true });
    },
  };
}

/** A store holding one entry that nothing links. */
export async function storeWithEntry(): Promise<{
  env: { OPM_STORE_HOME: string };
  store: string;
  key: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'opm-lease-'));
  temps.push(base);
  const store = join(base, 'store');
  const bytes = packTarGzip([
    {
      path: 'package/index.js',
      contents: new TextEncoder().encode(`module.exports = '${base}';\n`),
    },
  ]);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const key = storeKeyFromDigest(digest);
  const env = { OPM_STORE_HOME: store };
  await materializeThroughSharedStore({
    digest,
    projectStorePath: join(base, 'gone', key),
    bytes,
    format: 'tar+gzip',
    env,
  });
  await rm(join(base, 'gone'), { recursive: true });
  return { env, store, key };
}

/** A promise and the function that settles it. */
export function signal(): { done: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const done = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { done, fire };
}
