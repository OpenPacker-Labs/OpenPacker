import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  NativeLockEntry,
  NativeRequirement,
} from '@openpacker/adapter-core';
import { NpmProjectFormat } from './project.js';

async function project(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-project-alias-'));
  await writeFile(join(dir, 'package.json'), contents);
  const format = new NpmProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected as an npm project');
  return {
    dir,
    format,
    detected,
    read: (name = 'package.json') => readFile(join(dir, name), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('package.json with npm: aliases', () => {
  it('reads an alias as a requirement on its target, installed under the key', async () => {
    const fixture = await project(
      JSON.stringify({
        dependencies: {
          'string-width-cjs': 'npm:string-width@^4.2.0',
          '@scope/old': 'npm:@scope/new',
          plain: '^1.0.0',
        },
      }),
    );
    try {
      const found = await fixture.format.readRequirements(fixture.detected);
      expect(found).toEqual([
        {
          purl: 'pkg:npm/string-width',
          name: 'string-width',
          installName: 'string-width-cjs',
          range: '^4.2.0',
          scope: 'runtime',
        },
        {
          purl: 'pkg:npm/%40scope/new',
          name: '@scope/new',
          installName: '@scope/old',
          scope: 'runtime',
        },
        {
          purl: 'pkg:npm/plain',
          name: 'plain',
          range: '^1.0.0',
          scope: 'runtime',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes an alias the way npm does, under its install name', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const requirements: NativeRequirement[] = [
        {
          purl: 'pkg:npm/string-width',
          name: 'string-width',
          installName: 'string-width-cjs',
          range: '^4.2.0',
          scope: 'runtime',
        },
        {
          purl: 'pkg:npm/string-width',
          name: 'string-width',
          range: '^5.1.2',
          scope: 'runtime',
        },
        {
          purl: 'pkg:npm/%40scope/new',
          name: '@scope/new',
          installName: 'old',
          scope: 'development',
        },
      ];
      await fixture.format.writeManifest(fixture.detected, requirements);
      expect(JSON.parse(await fixture.read())).toMatchObject({
        dependencies: {
          'string-width': '^5.1.2',
          'string-width-cjs': 'npm:string-width@^4.2.0',
        },
        devDependencies: { old: 'npm:@scope/new@*' },
      });
      // And what it wrote reads back as what was asked for.
      const again = await fixture.format.readRequirements(fixture.detected);
      expect(
        again.map((item) => [item.installName ?? item.name, item.name]).sort(),
      ).toEqual([
        ['old', '@scope/new'],
        ['string-width', 'string-width'],
        ['string-width-cjs', 'string-width'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('retires an alias by its install name', async () => {
    const fixture = await project(
      JSON.stringify({
        dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' },
      }),
    );
    try {
      await fixture.format.writeManifest(fixture.detected, [], {
        retire: ['string-width-cjs'],
      });
      expect(JSON.parse(await fixture.read()).dependencies).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

const sri = { algorithm: 'sha512', value: 'AAAA', encoding: 'sri' };

function entry(
  name: string,
  version: string,
  extra: Partial<NativeLockEntry> = {},
): NativeLockEntry {
  return {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    digest: `sha256:${'a'.repeat(64)}`,
    size: 1,
    nativeIntegrity: sri,
    transitive: true,
    alias: `${name}@${version}`,
    ...extra,
  };
}

describe('package-lock.json for several versions and aliases', () => {
  it('writes each version where Node finds it, and an alias under its name', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const result = await fixture.format.writeLockfile!(fixture.detected, [
        entry('cliui', '8.0.2', {
          transitive: false,
          dependencies: ['string-width@5.1.2'],
          aliases: { 'string-width-cjs': 'string-width@4.2.3' },
        }),
        entry('string-width', '5.1.2'),
        entry('string-width', '4.2.3'),
        entry('plain', '1.0.0', { transitive: false, alias: 'plain@1.0.0' }),
      ]);
      expect(result.written).toHaveLength(1);
      const lock = JSON.parse(await fixture.read('package-lock.json')) as {
        packages: Record<string, { name?: string; version?: string }>;
      };
      expect(
        Object.entries(lock.packages)
          .filter(([path]) => path !== '')
          .map(
            ([path, value]) => `${path}=${value.name ?? ''}@${value.version}`,
          )
          .sort(),
      ).toEqual([
        'node_modules/cliui=@8.0.2',
        'node_modules/plain=@1.0.0',
        'node_modules/string-width-cjs=string-width@4.2.3',
        'node_modules/string-width=@5.1.2',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('nests the second version of a name instead of dropping one', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      await fixture.format.writeLockfile!(fixture.detected, [
        entry('a', '1.0.0', {
          transitive: false,
          dependencies: ['c@1.0.0'],
        }),
        entry('b', '1.0.0', {
          transitive: false,
          dependencies: ['c@2.0.0'],
        }),
        entry('c', '1.0.0'),
        entry('c', '2.0.0'),
      ]);
      const lock = JSON.parse(await fixture.read('package-lock.json')) as {
        packages: Record<string, { version?: string }>;
      };
      expect(
        Object.keys(lock.packages)
          .filter((path) => path.includes('/c'))
          .sort(),
      ).toEqual(['node_modules/a/node_modules/c', 'node_modules/c']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes the root dependencies with an alias in its npm: spelling', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      await fixture.format.writeLockfile!(fixture.detected, [
        entry('string-width', '4.2.3', {
          transitive: false,
          installName: 'string-width-cjs',
          range: '^4.2.0',
        }),
      ]);
      const lock = JSON.parse(await fixture.read('package-lock.json')) as {
        packages: Record<string, { dependencies?: Record<string, string> }>;
      };
      expect(lock.packages['']?.dependencies).toEqual({
        'string-width-cjs': 'npm:string-width@^4.2.0',
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
