import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { EXIT_CODES, runOpm } from '../src/opm.js';

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

function capture() {
  const seen = { out: '', err: '' };
  return {
    seen,
    io: {
      stdout: { write: (s: string) => ((seen.out += s), true) },
      stderr: { write: (s: string) => ((seen.err += s), true) },
    },
  };
}

const URL_OF = 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz';
const PATCH = [
  'diff --git a/index.js b/index.js',
  '--- a/index.js',
  '+++ b/index.js',
  '@@ -1 +1 @@',
  "-module.exports = 'lib';",
  "+module.exports = 'patched';",
  '',
].join('\n');

/** A project whose lock patches `lib@1.0.0` with `patch` (the file holds `file`). */
async function project(file: string | null = PATCH, patch = PATCH) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-patch-'));
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-patch-store-'));
  temps.push(dir, store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const bytes = packTarGzip([
    {
      path: 'package/package.json',
      contents: new TextEncoder().encode('{"name":"lib","version":"1.0.0"}'),
    },
    {
      path: 'package/index.js',
      contents: new TextEncoder().encode("module.exports = 'lib';\n"),
    },
  ]);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const hash = createHash('sha256').update(patch).digest('hex');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { lib: '1.0.0' },
      pnpm: { patchedDependencies: { 'lib@1.0.0': 'patches/lib.patch' } },
    }),
  );
  if (file !== null) {
    await mkdir(join(dir, 'patches'));
    await writeFile(join(dir, 'patches', 'lib.patch'), file);
  }
  await writeFile(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  lib@1.0.0:
    hash: ${hash}
    path: patches/lib.patch

importers:

  .:
    dependencies:
      lib:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${hash})

packages:

  lib@1.0.0:
    resolution: {integrity: ${integrity}}

snapshots:

  lib@1.0.0(patch_hash=${hash}): {}
`,
  );
  const fetcher = (async (input: string | URL | Request) =>
    String(input) === URL_OF
      ? new Response(bytes)
      : new Response(null, { status: 404 })) as typeof fetch;
  return { dir, fetcher };
}

describe('opm ci with a pnpm lock that patches a package', () => {
  it('says in the plan and the install what is patched, and installs the patched files', async () => {
    const p = await project();
    const plan = capture();
    expect(await runOpm(['ci', '--plan', '--path', p.dir], plan.io, '/')).toBe(
      EXIT_CODES.success,
    );
    expect(plan.seen.out).toContain(
      '  patched: 1 package by 1 patch from patchedDependencies, each a store entry of its own\n',
    );
    const install = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], install.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.success);
    expect(install.seen.err).toBe('');
    expect(install.seen.out).toContain('  patched: 1 package by 1 patch');
    expect(
      await readFile(join(p.dir, 'node_modules/lib/index.js'), 'utf8'),
    ).toBe("module.exports = 'patched';\n");
  });

  it('exits 3 for a patch that does not apply, and 4 for a patch file that is not there', async () => {
    const wrong = PATCH.replace("-module.exports = 'lib';", '-something else');
    const failing = await project(wrong, wrong);
    const c = capture();
    expect(
      await runOpm(['ci', '--path', failing.dir], c.io, '/', {
        fetch: failing.fetcher,
      }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.seen.err).toContain('ERR_PNPM_PATCH_FAILED');
    const missing = await project(null);
    const m = capture();
    expect(
      await runOpm(['ci', '--plan', '--path', missing.dir], m.io, '/'),
    ).toBe(EXIT_CODES.notFound);
    expect(m.seen.err).toContain(
      'the patch file "patches/lib.patch" does not exist',
    );
  });

  it('refuses at --plan, exit 7, a patch that names a path 2,000 directories deep', async () => {
    const path = `${'d/'.repeat(2_000)}x.js`;
    const deep = PATCH.split('index.js').join(path);
    const p = await project(deep, deep);
    const c = capture();
    expect(await runOpm(['ci', '--plan', '--path', p.dir], c.io, '/')).toBe(
      EXIT_CODES.verificationFailed,
    );
    expect(c.seen.out).toBe('');
    expect(c.seen.err).toContain(
      'is 2001 segments deep, more than the 128 a path in an archive may be',
    );
  });
});
