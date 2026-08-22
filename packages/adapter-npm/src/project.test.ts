import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { NpmProjectFormat } from './project.js';

async function project(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-project-'));
  await writeFile(join(dir, 'package.json'), contents);
  const format = new NpmProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected as an npm project');
  return {
    dir,
    format,
    detected,
    read: () => readFile(join(dir, 'package.json'), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({
  purl: name.startsWith('@')
    ? `pkg:npm/%40${name.slice(1).replace('/', '/')}`
    : `pkg:npm/${name}`,
  name,
  range,
  scope,
});

describe('NpmProjectFormat', () => {
  it('does not detect a directory with no package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'npm-project-'));
    try {
      expect(await new NpmProjectFormat().detect(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds a dependency without reformatting the rest of the file', async () => {
    const original = [
      '{',
      '\t"name": "demo",',
      '\t"version": "1.0.0",',
      '\t"scripts": {',
      '\t\t"build": "tsc"',
      '\t},',
      '\t"dependencies": {',
      '\t\t"zod": "^3.0.0"',
      '\t}',
      '}',
      '',
    ].join('\n');
    const fixture = await project(original);
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('zod', '^3.0.0'),
        requirement('chalk', '^4.1.2'),
      ]);
      expect(result.written).toEqual([fixture.detected.manifestPath]);
      const text = await fixture.read();
      // Tabs kept, unrelated keys untouched, new entry sorted in.
      expect(text).toContain('\t"scripts": {\n\t\t"build": "tsc"\n\t},');
      expect(text).toContain('\t\t"chalk": "^4.1.2",\n\t\t"zod": "^3.0.0"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('moves a dependency when its scope changes instead of leaving two copies', async () => {
    const fixture = await project(
      '{\n  "name": "demo",\n  "dependencies": {\n    "vitest": "^1.0.0"\n  }\n}\n',
    );
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('vitest', '^1.0.0', 'development'),
      ]);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const parsed = JSON.parse(await fixture.read()) as Record<
        string,
        Record<string, string>
      >;
      expect(parsed.devDependencies).toEqual({ vitest: '^1.0.0' });
      // A leftover copy in `dependencies` would let npm install it as runtime.
      expect(parsed.dependencies).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent — a second write changes nothing', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const reqs = [
        requirement('chalk', '^4.1.2'),
        requirement('@scope/pkg', '~2.0.0', 'development'),
      ];
      await fixture.format.writeManifest(fixture.detected, reqs);
      const first = await fixture.read();
      const second = await fixture.format.writeManifest(fixture.detected, reqs);
      expect(second.written).toEqual([]);
      expect(await fixture.read()).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it('round-trips scoped names through PURL and back', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('@scope/pkg', '^1.2.3'),
      ]);
      const read = await fixture.format.readRequirements(fixture.detected);
      expect(read).toEqual([
        {
          purl: 'pkg:npm/%40scope/pkg',
          name: '@scope/pkg',
          range: '^1.2.3',
          scope: 'runtime',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes * rather than an empty range npm would reject', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      await fixture.format.writeManifest(fixture.detected, [
        { purl: 'pkg:npm/chalk', name: 'chalk', scope: 'runtime' },
      ]);
      expect(JSON.parse(await fixture.read()).dependencies).toEqual({
        chalk: '*',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports loss for a scope npm cannot express, and writes nothing for it', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('cmake-js', '^7.0.0', 'build'),
      ]);
      expect(result.semanticLoss).toHaveLength(1);
      expect(result.semanticLoss[0]?.code).toBe('NATIVE_SCOPE_UNSUPPORTED');
      expect(await fixture.read()).toBe('{\n  "name": "demo"\n}\n');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('NpmProjectFormat — package-lock.json', () => {
  const entry = (
    name: string,
    version: string,
    integrity?: { algorithm: string; value: string; encoding: string },
  ) => ({
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    range: `^${version}`,
    scope: 'runtime' as const,
    source: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    digest: `sha256:${'0'.repeat(64)}`,
    size: 10,
    transitive: false,
    ...(integrity && { nativeIntegrity: integrity }),
  });
  const sri = { algorithm: 'sha512', value: 'AAAA', encoding: 'sri' };

  it('writes lockfileVersion 3 with the integrity npm verifies', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const result = await fixture.format.writeLockfile!(fixture.detected, [
        entry('chalk', '4.1.2', sri),
      ]);
      expect(result.written).toHaveLength(1);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const lock = JSON.parse(
        await readFile(join(fixture.dir, 'package-lock.json'), 'utf8'),
      ) as {
        lockfileVersion: number;
        packages: Record<string, { integrity?: string; resolved?: string }>;
      };
      expect(lock.lockfileVersion).toBe(3);
      expect(lock.packages['node_modules/chalk']?.integrity).toBe(
        'sha512-AAAA',
      );
      expect(lock.packages['node_modules/chalk']?.resolved).toContain(
        'registry.npmjs.org',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes no lockfile at all when one package has no integrity', async () => {
    const fixture = await project('{\n  "name": "demo"\n}\n');
    try {
      const result = await fixture.format.writeLockfile!(fixture.detected, [
        entry('chalk', '4.1.2', sri),
        entry('mystery', '1.0.0'),
      ]);
      // A partial lockfile is how a build silently installs something nobody
      // pinned, so it is all or nothing.
      expect(result.written).toEqual([]);
      expect(result.semanticLoss[0]?.code).toBe(
        'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
      );
      await expect(
        readFile(join(fixture.dir, 'package-lock.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('NpmProjectFormat — pack', () => {
  it('builds a tarball with the package/ prefix and honours files', async () => {
    const fixture = await project(
      '{\n  "name": "@scope/demo",\n  "version": "2.1.0",\n  "files": ["lib"]\n}\n',
    );
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(fixture.dir, 'lib'), { recursive: true });
      await writeFile(join(fixture.dir, 'lib', 'index.js'), 'export {};\n');
      await writeFile(join(fixture.dir, 'secret.txt'), 'not published\n');

      const artifact = await fixture.format.pack!(fixture.detected);
      expect(artifact.path.endsWith('scope-demo-2.1.0.tgz')).toBe(true);
      expect(artifact.exactPurl).toBe('pkg:npm/%40scope/demo@2.1.0');
      expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

      const { inspectArchive } = await import('@openpacker/materializer');
      const { readFile: read } = await import('node:fs/promises');
      const entries = await inspectArchive(
        new Uint8Array(await read(artifact.path)),
        'tar+gzip',
      );
      const paths = entries.map((entry) => entry.path).sort();
      expect(paths).toContain('package/lib/index.js');
      // package.json is always published; secret.txt is outside `files`.
      expect(paths).toContain('package/package.json');
      expect(paths).not.toContain('package/secret.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  it('says plainly that npm pack was not run', async () => {
    const fixture = await project(
      '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n',
    );
    try {
      const artifact = await fixture.format.pack!(fixture.detected);
      expect(artifact.semanticLoss[0]?.code).toBe(
        'NATIVE_PACK_NOT_TOOL_EQUIVALENT',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects traversal in package metadata before writing', async () => {
    const fixture = await project(
      '{"name":"demo","version":"../../../victim"}\n',
    );
    try {
      await expect(
        fixture.format.pack!(fixture.detected),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      await expect(readFile(join(fixture.dir, 'victim.tgz'))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});
