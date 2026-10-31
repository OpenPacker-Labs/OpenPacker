import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planFrozen } from '../src/index.js';
import { cleanup, pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { storedNames } from './frozen-workspace-fixture.js';

afterEach(cleanup);

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;
const arm = { os: 'linux', architecture: 'arm64', libc: 'glibc' } as const;

/**
 * The workspace of `frozen-install.pnpm.test.ts` less its peers, with what the
 * options choose between: a project dependency, a dev tool, an optional
 * package per cpu, and two members, `web` linking `lib`.
 */
async function fixture(root: Record<string, unknown> = {}): Promise<PnpmWorld> {
  const w = await pnpmWorld();
  w.pkg({ name: 'shared', version: '1.0.0' });
  w.pkg({ name: 'a', version: '1.0.0', deps: { shared: '1.0.0' } });
  w.pkg({
    name: 'tool',
    version: '1.0.0',
    manifest: { bin: { tool: 'index.js' } },
  });
  w.pkg({ name: 'left', version: '1.0.0' });
  w.pkg({ name: 'right', version: '1.0.0' });
  w.pkg({
    name: 'plat-x64',
    version: '1.0.0',
    os: ['linux'],
    cpu: ['x64'],
    optional: true,
  });
  w.pkg({
    name: 'plat-arm64',
    version: '1.0.0',
    os: ['linux'],
    cpu: ['arm64'],
    optional: true,
  });
  w.importer(
    '.',
    {
      dependencies: { a: ['^1.0.0', '1.0.0'] },
      devDependencies: { tool: ['^1.0.0', '1.0.0'] },
      optionalDependencies: {
        'plat-x64': ['^1.0.0', '1.0.0'],
        'plat-arm64': ['^1.0.0', '1.0.0'],
      },
    },
    root,
  );
  w.importer('packages/web', {
    dependencies: {
      left: ['^1.0.0', '1.0.0'],
      lib: ['workspace:*', 'link:../lib'],
    },
  });
  w.importer('packages/lib', { dependencies: { right: ['^1.0.0', '1.0.0'] } });
  await w.write();
  return w;
}

describe('the platforms of a pnpm install', () => {
  it('installs the optional package for the machines it is told, and only those', async () => {
    const w = await fixture();
    const result = await w.install({ targets: [linux, arm] });
    expect(await w.list('node_modules')).toEqual(
      expect.arrayContaining(['plat-x64', 'plat-arm64']),
    );
    expect(result.skipped).toEqual([]);
    expect(result.targets).toEqual([linux, arm]);
  });

  it('installs the host alone otherwise, and reports the other as left out', async () => {
    const w = await fixture();
    const result = await w.install();
    expect(await w.list('node_modules')).toContain('plat-x64');
    expect(await w.list('node_modules')).not.toContain('plat-arm64');
    expect(result.skipped.map((item) => [item.name, item.kind])).toEqual([
      ['plat-arm64', 'platform'],
    ]);
    expect(result.targets).toBeUndefined();
  });

  it("widens to the project's own supportedArchitectures only when asked", async () => {
    const w = await fixture({
      pnpm: { supportedArchitectures: { cpu: ['arm64', 'x64'] } },
    });
    expect(await w.list('.')).not.toContain('node_modules');
    const asked = await w.install({ architectures: 'project' });
    expect(await w.list('node_modules')).toEqual(
      expect.arrayContaining(['plat-x64', 'plat-arm64']),
    );
    expect(asked.targets).toHaveLength(2);
    const w2 = await fixture({
      pnpm: { supportedArchitectures: { cpu: ['arm64', 'x64'] } },
    });
    await w2.install();
    expect(await w2.list('node_modules')).not.toContain('plat-arm64');
  });

  // pnpm writes `libc` only when the registry's metadata had it, so a lock can
  // list a musl build as for linux/x64 alone; the archive's own package.json
  // says musl (OpenSesame: @anthropic-ai/claude-agent-sdk-linux-x64-musl, 258 MiB).
  it("leaves out an optional package whose package.json names another libc than the lock's, and never extracts it", async () => {
    const w = await pnpmWorld();
    const native = (name: string, libc: string) =>
      w.pkg({
        name,
        version: '1.0.0',
        os: ['linux'],
        cpu: ['x64'],
        optional: true,
        manifest: { os: ['linux'], cpu: ['x64'], libc: [libc] },
      });
    native('sdk-linux-x64', 'glibc');
    native('sdk-linux-x64-musl', 'musl');
    w.pkg({
      name: 'sdk',
      version: '1.0.0',
      optionalDeps: {
        'sdk-linux-x64': '1.0.0',
        'sdk-linux-x64-musl': '1.0.0',
      },
    });
    w.importer('.', { dependencies: { sdk: ['^1.0.0', '1.0.0'] } });
    await w.write();

    const result = await w.install();

    expect(await w.list('node_modules')).toEqual([
      '.opm-layout.json',
      'sdk',
      'sdk-linux-x64',
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        name: 'sdk-linux-x64-musl',
        kind: 'platform',
        reason: expect.stringMatching(/libc "musl".*its package\.json/u),
      }),
    ]);
    expect(result.installed).toBe(2);
    expect(await storedNames(`${w.dir}-store`)).toEqual([
      'sdk',
      'sdk-linux-x64',
    ]);
  });

  it('refuses a package that does not run here and is not optional, before it fetches', async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'arm-only', version: '1.0.0', cpu: ['arm64'] });
    w.importer('.', { dependencies: { 'arm-only': ['^1.0.0', '1.0.0'] } });
    await w.write();
    await expect(w.install()).rejects.toThrow(
      /"arm-only@1\.0\.0" is for cpu "arm64", not "linux\/x64\/glibc", and is not optional/u,
    );
    expect(w.registry.requests).toEqual([]);
  });
});

describe('choosing members of a pnpm workspace', () => {
  // HoBo lists the members of a git submodule in pnpm-workspace.yaml; in a
  // checkout that has not initialised it they are not there, and the member
  // that links one cannot be selected. Saying so beats "no member is named".
  it('names the members the workspace lists that are not on disk, when a filtered member links one', async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'left', version: '1.0.0' });
    w.importer('.', {}, { name: 'root' });
    w.importer('packages/app', {
      dependencies: {
        lib: ['workspace:*', 'link:../../vendor/lib'],
        left: ['^1.0.0', '1.0.0'],
      },
    });
    w.importer('vendor/lib', {});
    await w.write({
      workspaceYaml: 'packages:\n  - "packages/*"\n  - "vendor/lib"\n',
    });
    await rm(join(w.dir, 'vendor'), { recursive: true });
    await expect(w.install({ workspace: { filter: ['app'] } })).rejects.toThrow(
      /no workspace member is named "lib".*pnpm-workspace\.yaml lists vendor\/lib, which is not on disk \(a git submodule that is not checked out\?\)/u,
    );
    expect(w.registry.requests).toEqual([]);
  });

  it('installs the filtered member, the members it links and what they need, not the project', async () => {
    const w = await fixture();
    await w.install({ workspace: { filter: ['web'] } });
    // The members' own dependencies are shared at the project, as npm -w
    // places them; the project's own (a, shared, tool) are not installed.
    expect(await w.list('node_modules')).toEqual([
      '.opm-layout.json',
      'left',
      'lib',
      'right',
    ]);
    expect(w.load('left/package.json', 'packages/web')).toMatchObject({
      version: '1.0.0',
    });
    expect(w.load('right/package.json', 'packages/lib')).toMatchObject({
      version: '1.0.0',
    });
  });

  it('adds the project with --include-workspace-root', async () => {
    const w = await fixture();
    await w.install({ workspace: { filter: ['web'], includeRoot: true } });
    expect(await w.list('node_modules')).toEqual(
      expect.arrayContaining(['a', 'shared', 'tool', 'lib']),
    );
  });

  it("reads pnpm's selectors: a dependency closure with ..., a glob, an exclusion", async () => {
    const w = await fixture();
    await w.install({ workspace: { filter: ['./packages/*', '!web'] } });
    expect(w.load('right/package.json', 'packages/lib')).toMatchObject({
      version: '1.0.0',
    });
    expect(await w.list('node_modules')).toEqual(['.opm-layout.json', 'right']);
    await expect(
      stat(join(w.dir, 'packages/web/node_modules')),
    ).rejects.toThrow();
  });

  it('names pnpm-workspace.yaml when a pnpm project has no workspace to select from', async () => {
    const w = await pnpmWorld();
    w.importer('.', {});
    await w.write();
    await rm(join(w.dir, 'pnpm-workspace.yaml'));
    await expect(w.install({ workspace: { filter: ['web'] } })).rejects.toThrow(
      /declares none \(no pnpm-workspace\.yaml\)/u,
    );
  });

  it('refuses a selector that matches nothing, before anything is fetched', async () => {
    const w = await fixture();
    await expect(
      w.install({ workspace: { filter: ['nothing-called-this'] } }),
    ).rejects.toThrow(/nothing-called-this/u);
    expect(w.registry.requests).toEqual([]);
  });

  it('refuses --filter together with -w, which read members by different grammars', async () => {
    const w = await fixture();
    await expect(
      w.install({ workspace: { filter: ['web'], select: ['web'] } }),
    ).rejects.toThrow(/pnpm's grammar and --workspace by npm's/u);
  });

  it('installs only the project with --workspaces=false, and no link', async () => {
    const w = await fixture();
    await w.install({ workspace: { ignore: true } });
    expect(await w.list('node_modules')).toEqual(
      expect.arrayContaining(['a', 'tool']),
    );
    expect(await w.list('node_modules')).not.toContain('lib');
    await expect(
      stat(join(w.dir, 'packages/web/node_modules')),
    ).rejects.toThrow();
  });
});

describe("a lock that is not the project's", () => {
  it('is refused before anything is fetched, and the previous node_modules is left alone', async () => {
    const w = await fixture();
    await mkdir(join(w.dir, 'node_modules'), { recursive: true });
    await writeFile(join(w.dir, 'node_modules/keep.txt'), 'kept');
    await writeFile(
      join(w.dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { a: '^2.0.0' },
      }),
    );
    await expect(w.install()).rejects.toThrow(
      /pnpm-lock\.yaml is not up to date with the project[\s\S]*the project: "a" is "\^2\.0\.0" in package\.json and "\^1\.0\.0" in pnpm-lock\.yaml/u,
    );
    expect(w.registry.requests).toEqual([]);
    expect(await w.read('node_modules/keep.txt')).toBe('kept');
  });
});

describe('planFrozen of a pnpm workspace', () => {
  it('says what the install would do and does none of it', async () => {
    const w = await fixture();
    const plan = await planFrozen({
      root: w.dir,
      transport: w.registry,
      env: { OPM_STORE_HOME: join(w.dir, '..', 'plan-store') },
      target: linux,
    });
    expect(plan).toMatchObject({
      ecosystem: 'npm',
      instances: 6,
      archives: 6,
      workspace: { members: 2, installed: 2, linked: 1 },
    });
    expect(plan.places).toBeGreaterThanOrEqual(plan.instances);
    expect(plan.skipped.map((item) => item.name)).toEqual(['plat-arm64']);
    expect(w.registry.requests).toEqual([]);
    await expect(stat(join(w.dir, 'node_modules'))).rejects.toThrow();
    await expect(stat(join(w.dir, '..', 'plan-store'))).rejects.toThrow();
  });

  it("plans a transitive registry package whose version has build metadata, which the policy takes as the registry's", async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'b', version: '1.0.0+build.5' });
    w.pkg({ name: 'a', version: '1.0.0', deps: { b: '1.0.0+build.5' } });
    w.importer('.', { dependencies: { a: ['^1.0.0', '1.0.0'] } });
    await w.write();
    const plan = await planFrozen({
      root: w.dir,
      transport: w.registry,
      env: { OPM_STORE_HOME: join(w.dir, '..', 'plan-store') },
      target: linux,
    });
    expect(plan).toMatchObject({ instances: 2, archives: 2 });
  });

  it('refuses what the install would, before the first byte', async () => {
    const w = await fixture();
    await writeFile(
      join(w.dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: {} }),
    );
    await expect(
      planFrozen({ root: w.dir, transport: w.registry, target: linux }),
    ).rejects.toThrow(/not up to date with the project/u);
  });
});
