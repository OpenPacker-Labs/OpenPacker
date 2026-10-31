/**
 * A project for `opm ci` whose packages declare install scripts, with a fetch
 * that serves their archives: what the tests of approved scripts install
 * (ADR 0060). Every package sits at `node_modules/<name>`, in the order given.
 */
import { accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { createNativeBackend } from '@openpacker/sandbox';

const temps: string[] = [];
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPM_STORE_HOME;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.OPM_STORE_HOME;
  else process.env.OPM_STORE_HOME = previous;
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function onPath(binary: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => {
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Approved scripts run in Bubblewrap; without it they are refused, which other tests cover. */
export const jailed =
  process.platform === 'linux' &&
  onPath('bwrap') &&
  createNativeBackend()?.id === 'native-bwrap';

export interface ScriptedPkg {
  name: string;
  /** Names it depends on, each at `1.0.0`. */
  dependencies?: readonly string[];
  scripts?: Record<string, string>;
  files?: Record<string, string>;
}

const INSTALL_EVENTS = ['preinstall', 'install', 'postinstall'];

/** The project: the root depends on `direct`, and `manifest` is merged into its package.json. */
export async function scriptedProject(
  packages: readonly ScriptedPkg[],
  direct: readonly string[],
  manifest: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-scripts-'));
  temps.push(dir);
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-scripts-store-'));
  temps.push(store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const entries: Record<string, unknown> = {};
  const versions = (names: readonly string[] = []) =>
    Object.fromEntries(names.map((name) => [name, '1.0.0']));
  for (const pkg of packages) {
    const own = {
      name: pkg.name,
      version: '1.0.0',
      ...(pkg.dependencies !== undefined && {
        dependencies: versions(pkg.dependencies),
      }),
      ...(pkg.scripts !== undefined && { scripts: pkg.scripts }),
    };
    const files = { 'package.json': JSON.stringify(own), ...pkg.files };
    const bytes = packTarGzip(
      Object.entries(files).map(([path, text]) => ({
        path: `package/${path}`,
        contents: new TextEncoder().encode(text),
      })),
    );
    const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-1.0.0.tgz`;
    archives.set(url, bytes);
    entries[`node_modules/${pkg.name}`] = {
      version: '1.0.0',
      resolved: url,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      ...(pkg.dependencies !== undefined && {
        dependencies: versions(pkg.dependencies),
      }),
      ...(Object.keys(pkg.scripts ?? {}).some((event) =>
        INSTALL_EVENTS.includes(event),
      ) && { hasInstallScript: true }),
    };
  }
  const root = {
    name: 'app',
    version: '1.0.0',
    dependencies: versions(direct),
    ...manifest,
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(root));
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': root, ...entries },
    }),
  );
  const fetcher = (async (input: string | URL | Request) => {
    const body = archives.get(
      typeof input === 'string' ? input : String(input),
    );
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(body);
  }) as typeof fetch;
  return { dir, fetcher };
}
