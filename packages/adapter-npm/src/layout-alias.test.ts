import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { LAYOUT_RECORD } from './layout-write.js';
import { planLayout, toLayoutEntries, type LayoutPlan } from './layout-plan.js';
import { NpmProjectFormat } from './project.js';

/**
 * Aliases in the layout: `"string-width-cjs": "npm:string-width@^4.2.0"` puts
 * the package in a directory called `string-width-cjs`, whose own package.json
 * still says `string-width`.
 */

interface Spec {
  direct?: boolean;
  /** Edges found under the package's own name: lock keys. */
  requires?: string[];
  /** Edges found under another name: install name → lock key. */
  aliases?: Record<string, string>;
  /** The name a direct entry is installed under. */
  installName?: string;
  bin?: string | Record<string, string>;
  files?: Record<string, string>;
}

/** `name@version` → a lock entry whose key is `key` (default: the same). */
function entry(id: string, spec: Spec = {}, key: string = id): NativeLockEntry {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  return {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: `https://registry.example/${name}-${version}.tgz`,
    digest: `sha256:${id.replace(/\W/gu, '').padEnd(64, '0')}`,
    size: 1,
    transitive: spec.direct !== true,
    alias: key,
    ...(spec.requires !== undefined && { dependencies: spec.requires }),
    ...(spec.aliases !== undefined && { aliases: spec.aliases }),
    ...(spec.installName !== undefined && { installName: spec.installName }),
  };
}

const where = (plan: LayoutPlan): string[] =>
  plan.placements
    .map((place) => `${place.chain.join('>')}=${place.entry.id}`)
    .sort();

describe('planning with install names', () => {
  it('puts an aliased dependency in a directory of its own name, beside the real one', () => {
    // @isaacs/cliui@8.0.2: string-width ^5.1.2 and string-width-cjs → ^4.2.0.
    const plan = planLayout(
      toLayoutEntries([
        entry('cliui@8.0.2', {
          direct: true,
          requires: ['string-width@5.1.2'],
          aliases: { 'string-width-cjs': 'string-width@4.2.3' },
        }),
        entry('string-width@5.1.2'),
        entry('string-width@4.2.3'),
      ]),
    );
    expect(where(plan)).toEqual([
      'cliui=cliui@8.0.2',
      'string-width-cjs=string-width@4.2.3',
      'string-width=string-width@5.1.2',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('installs one release twice when it is wanted under two names', () => {
    const plan = planLayout(
      toLayoutEntries([
        entry('app@1.0.0', {
          direct: true,
          requires: ['string-width@4.2.3'],
          aliases: { 'string-width-cjs': 'string-width@4.2.3' },
        }),
        entry('string-width@4.2.3'),
      ]),
    );
    expect(where(plan)).toEqual([
      'app=app@1.0.0',
      'string-width-cjs=string-width@4.2.3',
      'string-width=string-width@4.2.3',
    ]);
  });

  it('nests an alias beside a dependent when the name is taken by another release', () => {
    // `a` wants string-width@5 (plain) and `b` wants string-width@4 as -cjs;
    // `c` also wants string-width@4, as `string-width`, which the root holds
    // at 5 if most of the closure wants that.
    const plan = planLayout(
      toLayoutEntries([
        entry('a@1.0.0', { direct: true, requires: ['string-width@5.1.2'] }),
        entry('c@1.0.0', { direct: true, requires: ['string-width@5.1.2'] }),
        entry('b@1.0.0', {
          direct: true,
          requires: ['string-width@4.2.3'],
          aliases: { 'string-width-cjs': 'string-width@4.2.3' },
        }),
        entry('string-width@5.1.2'),
        entry('string-width@4.2.3'),
      ]),
    );
    expect(where(plan)).toEqual([
      'a=a@1.0.0',
      'b=b@1.0.0',
      'b>string-width=string-width@4.2.3',
      'c=c@1.0.0',
      'string-width-cjs=string-width@4.2.3',
      'string-width=string-width@5.1.2',
    ]);
  });

  it('judges an install name that shadows another package by what it resolves to', () => {
    // `shim` finds preact as `react`; `real` finds react. They cannot share a
    // directory called react.
    const plan = planLayout(
      toLayoutEntries([
        entry('shim@1.0.0', {
          direct: true,
          aliases: { react: 'preact@10.0.0' },
        }),
        entry('real@1.0.0', { direct: true, requires: ['react@18.0.0'] }),
        entry('preact@10.0.0'),
        entry('react@18.0.0'),
      ]),
    );
    const places = where(plan);
    expect(places).toContain('react=react@18.0.0');
    expect(places).toContain('shim>react=preact@10.0.0');
    expect(places).not.toContain('react=preact@10.0.0');
  });

  it('installs a direct alias under its install name and not its own', () => {
    const plan = planLayout(
      toLayoutEntries([
        entry('string-width@4.2.3', {
          direct: true,
          installName: 'string-width-cjs',
        }),
        entry('string-width@5.1.2', { direct: true }),
      ]),
    );
    expect(where(plan)).toEqual([
      'string-width-cjs=string-width@4.2.3',
      'string-width=string-width@5.1.2',
    ]);
  });

  it('refuses two directs that want one name, whether or not it is an alias', () => {
    const plan = planLayout(
      toLayoutEntries([
        entry('string-width@4.2.3', {
          direct: true,
          installName: 'string-width',
        }),
        entry('string-width@5.1.2', { direct: true }),
      ]),
    );
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toMatch(
      /string-width@\d.* and string-width@\d.* are both required directly as string-width/u,
    );
  });

  it.each([
    ['../escape'],
    ['node_modules'],
    ['.bin'],
    ['a/b/c'],
    [''],
    ['a b'],
  ])('leaves out an alias named %j, whatever the lock says', (name) => {
    const plan = planLayout(
      toLayoutEntries([
        entry('app@1.0.0', {
          direct: true,
          aliases: { [name]: 'string-width@4.2.3' },
        }),
        entry('string-width@4.2.3'),
      ]),
    );
    expect(where(plan)).toEqual(['app=app@1.0.0']);
    expect(plan.skipped.map((item) => item.entry.id)).toEqual([
      'string-width@4.2.3',
    ]);
    expect(plan.skipped[0]?.reason).toContain('requires it as');
  });

  it('plans a lock with no aliases as it did', () => {
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['c@1.0.0'] }),
      entry('b@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@1.0.0'),
      entry('c@2.0.0'),
    ];
    // The newest of two equally wanted versions takes the root, as before
    // aliases were read (a differential run against the previous planner over
    // 6,000 random alias-free locks placed and skipped identically).
    expect(where(planLayout(toLayoutEntries(entries)))).toEqual([
      'a=a@1.0.0',
      'a>c=c@1.0.0',
      'b=b@1.0.0',
      'c=c@2.0.0',
    ]);
  });
});

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** An entry with a real extracted tree in a store directory. */
async function stored(
  dir: string,
  counter: number,
  id: string,
  spec: Spec = {},
  key: string = id,
): Promise<NativeLockEntry> {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  const storePath = join(dir, 'store', `sha256-${counter}`);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name,
      version,
      main: 'index.js',
      ...(spec.bin !== undefined && { bin: spec.bin }),
    }),
    'index.js': `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`,
    ...spec.files,
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(storePath, 'package', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { mode: 0o755 });
  }
  return {
    ...entry(id, spec, key),
    digest: `sha256:${String(counter).padStart(64, '0')}`,
    storePath,
  };
}

async function project(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'npm-alias-'));
  temps.push(dir);
  const root = join(dir, 'project');
  await mkdir(root, { recursive: true });
  return { dir, root };
}

const node = (cwd: string, script: string): string =>
  execFileSync(process.execPath, ['-e', script], {
    cwd,
    encoding: 'utf8',
  }).trim();

async function writeLayout(root: string, entries: NativeLockEntry[]) {
  const format = new NpmProjectFormat();
  const detected = await format.detectLayout(root);
  if (!detected) throw new Error('layout target missing');
  return format.writeLayout(detected, entries);
}

describe('writing a layout with aliases', () => {
  it('lets Node require each name from the dependent, and the package keeps its own name', async () => {
    const { dir, root } = await project();
    const files = {
      'index.js':
        "module.exports = { plain: require('string-width').version, cjs: require('string-width-cjs').version, own: require('string-width-cjs/package.json').name };\n",
    };
    const entries = [
      await stored(dir, 1, 'cliui@8.0.2', {
        direct: true,
        requires: ['string-width@5.1.2'],
        aliases: { 'string-width-cjs': 'string-width@4.2.3' },
        files,
      }),
      await stored(dir, 2, 'string-width@5.1.2'),
      await stored(dir, 3, 'string-width@4.2.3'),
    ];
    await writeLayout(root, entries);
    expect(node(root, "console.log(JSON.stringify(require('cliui')))")).toBe(
      JSON.stringify({ plain: '5.1.2', cjs: '4.2.3', own: 'string-width' }),
    );
    const record = JSON.parse(
      await readFile(join(root, 'node_modules', LAYOUT_RECORD), 'utf8'),
    ) as { packages: string[] };
    expect(record.packages.sort()).toEqual([
      'cliui',
      'string-width',
      'string-width-cjs',
    ]);
  });

  it('names a bare bin by the package and addresses it by the directory it is in', async () => {
    const { dir, root } = await project();
    const entries = [
      await stored(dir, 1, 'string-width@4.2.3', {
        direct: true,
        installName: 'string-width-cjs',
        bin: 'cli.js',
        files: { 'cli.js': "#!/usr/bin/env node\nconsole.log('ran');\n" },
      }),
    ];
    await writeLayout(root, entries);
    const shim = await readFile(
      join(root, 'node_modules', '.bin', 'string-width'),
      'utf8',
    );
    expect(shim).toContain('/../string-width-cjs/cli.js');
    expect(
      execFileSync(join(root, 'node_modules', '.bin', 'string-width'), {
        encoding: 'utf8',
      }).trim(),
    ).toBe('ran');
  });

  it('removes an aliased directory when the next layout no longer has it', async () => {
    const { dir, root } = await project();
    const first = [
      await stored(dir, 1, 'string-width@4.2.3', {
        direct: true,
        installName: 'string-width-cjs',
      }),
    ];
    await writeLayout(root, first);
    const second = [await stored(dir, 2, 'other@1.0.0', { direct: true })];
    await writeLayout(root, second);
    expect(node(root, "console.log(require('other').version)")).toBe('1.0.0');
    expect(() => node(root, "require('string-width-cjs')")).toThrow();
  });
});
