/**
 * An install against a shared store it may read but not write: a store root
 * of mode 0500 seen by a user who is not root, and a read-only bind mount.
 * Before leases such an install adopted what the store held and wrote
 * nothing there; it still must, and must still wait while a collection
 * settles an entry it wants.
 *
 * `opm ci` (`installFrozen`) and `opm install`'s way through the store
 * (`materializeThroughSharedStore`) run in a child process in a user
 * namespace (and, for the read-only mount, a mount namespace) made with
 * `unshare`, as uid 1000 or as the namespace's root. Where `unshare` cannot
 * make them, the tests are skipped and say so.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmod, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openCollection } from '../src/shared-store-lease.js';
import { leaseDirectory } from '../src/store-lease.js';
import { cleanupWorlds, scratch, world } from './gc-race-fixture.js';
import { childEnv, source, tsNodeArgs } from './ts-child.js';

afterEach(cleanupWorlds);

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** What the child does, saying each result as a line of JSON. */
const SCRIPT = `
const [src, root, store, key] = process.argv.slice(1);
const { createInterface } = await import('node:readline');
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const run = (promise) =>
  promise.then((ok) => ({ ok }), (error) => ({ error: error.code ?? String(error) }));
const { configureDefaultAdapters } = await import('@openpacker/adapters-default');
configureDefaultAdapters();
const { installFrozen } = await import(src + '/frozen-install.ts');
const { holdSharedStore } = await import(src + '/shared-store-lease.ts');
const { openLease } = await import(src + '/store-lease.ts');
const env = { OPM_STORE_HOME: store };
const ci = await run(
  installFrozen({ root, env, offline: true, now: () => '2026-10-17T12:00:00.000Z' })
    .then((result) => ({ fromStore: result.fromStore, fetched: result.fetched })),
);
const { materializeThroughSharedStore } = await import(src + '/shared-store.ts');
const install = await run(
  materializeThroughSharedStore({
    digest: 'sha256:' + key.slice('sha256-'.length),
    projectStorePath: root + '/.opm-install-probe',
    bytes: async () => {
      throw new Error('offline: the store has it');
    },
    format: 'tar+gzip',
    env,
  }).then((result) => result.shared),
);
const lease = await run(openLease(store + '/.leases-probe', 'gc').then(() => 'made'));
say({ ci, install, lease });
await input.next();
let pauses = 0;
const hold = await holdSharedStore(store, {
  pause: async () => {
    pauses += 1;
    if (pauses === 1) say({ waiting: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
  },
});
const claim = await run(hold.claim(key).then(() => 'claimed'));
await hold.release();
say({ claim, pauses });
process.exit(0);
`;

/** opm ci online, its archives served from a file the test wrote. */
const FETCH_SCRIPT = `
const [src, root, store, served] = process.argv.slice(1);
const { readFile } = await import('node:fs/promises');
const { configureDefaultAdapters } = await import('@openpacker/adapters-default');
configureDefaultAdapters();
const { installFrozen } = await import(src + '/frozen-install.ts');
const archives = JSON.parse(await readFile(served, 'utf8'));
const transport = {
  async request(request) {
    const body = archives[request.url];
    if (body === undefined) throw new Error('not served: ' + request.url);
    return { status: 200, headers: {}, body: Buffer.from(body, 'base64'), url: request.url };
  },
};
const outcome = await installFrozen({
  root,
  env: { OPM_STORE_HOME: store },
  transport,
  now: () => '2026-10-17T12:00:00.000Z',
}).then(
  (result) => ({ fetched: result.fetched }),
  (error) => ({ code: error.code, message: error.message }),
);
process.stdout.write(JSON.stringify(outcome) + '\\n');
`;

function works(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

const NOT_ROOT = ['unshare', '--map-user=1000', '--map-group=1000'];
const READ_ONLY = [
  'unshare',
  '-r',
  '-m',
  'sh',
  '-c',
  'mount --bind -o ro "$OPM_RO_STORE" "$OPM_RO_STORE" && exec "$@"',
  'sh',
];

const canDropUser = works(NOT_ROOT[0]!, [...NOT_ROOT.slice(1), 'true']);
const canMountReadOnly = (() => {
  const probe = spawnSync('mktemp', ['-d'], { encoding: 'utf8' }).stdout.trim();
  if (probe === '') return false;
  const ok = works('unshare', [
    '-r',
    '-m',
    'sh',
    '-c',
    'mount --bind -o ro "$0" "$0" && ! touch "$0/probe" 2>/dev/null',
    probe,
  ]);
  spawnSync('rm', ['-rf', probe]);
  return ok;
})();

/**
 * Install offline from a populated store the child cannot write, then claim
 * an entry a live collection here has announced, and settle it once the
 * child says it waits.
 */
async function againstUnwritableStore(
  wrap: readonly string[],
  lockDown: (store: string) => Promise<void>,
) {
  const w = await world(1);
  await w.install(0);
  await w.unlink(0);
  const key = (await readdir(w.store)).find((name) =>
    /^sha256-[0-9a-f]{64}$/u.test(name),
  )!;
  await lockDown(w.store);
  const node = tsNodeArgs(SCRIPT, [
    dirname(source('index')),
    w.dirs[0]!,
    w.store,
    key,
  ]);
  const child = spawn(wrap[0]!, [...wrap.slice(1), process.execPath, ...node], {
    cwd: PACKAGE,
    env: childEnv({ OPM_RO_STORE: w.store }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! })[
    Symbol.asyncIterator
  ]();
  const next = async (): Promise<Record<string, unknown>> => {
    const { value, done } = await lines.next();
    if (done === true) throw new Error('the child ended early');
    return JSON.parse(String(value)) as Record<string, unknown>;
  };
  try {
    const first = await next();
    const afterInstall = await readdir(w.store);
    const collection = await openCollection(w.store, false);
    await collection.claimed(key);
    // The collection's lease directory is the child's to read, not write.
    await chmod(leaseDirectory(w.store), 0o500);
    child.stdin!.write('go\n');
    const waiting = await next();
    const whileWaiting = await readdir(leaseDirectory(w.store));
    await collection.settled(key);
    const last = await next();
    await collection.release();
    return {
      ...first,
      ...waiting,
      ...last,
      // What the child wrote into the store: nothing, then no lease of its own.
      storeAfterInstall: afterInstall.filter((name) => name.startsWith('.')),
      installLeases: whileWaiting.filter((name) => name.startsWith('install.')),
    };
  } finally {
    child.kill('SIGKILL');
    await chmod(w.store, 0o700);
  }
}

describe('an install against a store it cannot write', () => {
  it('adopts what the store holds, writes nothing there, and still waits on a collection, as a user the store root (0500) does not let write', async (context) => {
    context.skip(
      !canDropUser,
      'unshare --map-user=1000 is not available here: cannot run as a user other than root',
    );
    const result = await againstUnwritableStore(NOT_ROOT, async (store) => {
      await chmod(store, 0o500);
    });

    expect(result).toMatchObject({
      ci: { ok: { fromStore: 2, fetched: 0 } },
      install: { ok: true },
      lease: { error: 'EACCES' },
      waiting: true,
      claim: { ok: 'claimed' },
      storeAfterInstall: [],
      installLeases: [],
    });
  }, 60_000);

  it('adopts what the store holds, writes nothing there, and still waits on a collection, through a read-only bind mount, and says EROFS when it cannot make a lease', async (context) => {
    context.skip(
      !canMountReadOnly,
      'unshare -r -m cannot bind-mount read-only here: no read-only store to test against',
    );
    const result = await againstUnwritableStore(READ_ONLY, async () => {});

    expect(result).toMatchObject({
      ci: { ok: { fromStore: 2, fetched: 0 } },
      install: { ok: true },
      lease: { error: 'EROFS' },
      waiting: true,
      claim: { ok: 'claimed' },
      storeAfterInstall: [],
      installLeases: [],
    });
  }, 60_000);

  it('says the store is read-only when it must add an entry there, not that the archive is unsafe', async (context) => {
    context.skip(
      !canMountReadOnly,
      'unshare -r -m cannot bind-mount read-only here: no read-only store to test against',
    );
    const w = await world(1);
    await w.install(0);
    await w.unlink(0);
    // One entry is not in the store: the install has to fetch and add it.
    const [missing] = (await readdir(w.store)).filter((name) =>
      name.startsWith('sha256-'),
    );
    await rm(join(w.store, missing!), { recursive: true, force: true });
    await rm(join(w.store, `${missing}.tree`), { force: true });
    const served = join(await scratch('opm-served-'), 'archives.json');
    await writeFile(
      served,
      JSON.stringify(
        Object.fromEntries(
          [...w.registry.archives].map(([url, bytes]) => [
            url,
            Buffer.from(bytes).toString('base64'),
          ]),
        ),
      ),
    );
    const node = tsNodeArgs(FETCH_SCRIPT, [
      dirname(source('index')),
      w.dirs[0]!,
      w.store,
      served,
    ]);
    const ran = spawnSync(
      READ_ONLY[0]!,
      [...READ_ONLY.slice(1), process.execPath, ...node],
      {
        cwd: PACKAGE,
        env: childEnv({ OPM_RO_STORE: w.store }),
        encoding: 'utf8',
      },
    );
    const outcome = JSON.parse(ran.stdout.trim()) as Record<string, string>;

    expect(outcome.code).not.toBe('UNSAFE_PATH');
    expect(outcome.message).toMatch(/EROFS|read-only file system/u);
  }, 60_000);
});
