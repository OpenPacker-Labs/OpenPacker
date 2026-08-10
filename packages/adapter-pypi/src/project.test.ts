import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { PypiProjectFormat } from './project.js';

const PYPROJECT = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "app"
version = "0.1.0"
dependencies = [
  "requests>=2.31",
]
`;

async function project(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pypi-project-'));
  await writeFile(join(dir, 'pyproject.toml'), contents);
  const format = new PypiProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected');
  return {
    format,
    detected,
    read: () => readFile(join(dir, 'pyproject.toml'), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({ purl: `pkg:pypi/${name}`, name, range, scope });

describe('PypiProjectFormat', () => {
  it('writes PEP 508 strings into project.dependencies', async () => {
    const fixture = await project(PYPROJECT);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('requests', '>=2.32'),
        requirement('httpx', '==0.27.0'),
      ]);
      const text = await fixture.read();
      expect(text).toContain('"requests>=2.32"');
      expect(text).toContain('"httpx==0.27.0"');
      expect(text).toContain('build-backend = "hatchling.build"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves a dependency it does not manage exactly where it was', async () => {
    const fixture = await project(PYPROJECT);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('httpx', '==0.27.0'),
      ]);
      const text = await fixture.read();
      // requests belongs to whoever wrote it; opm never claimed it.
      expect(text).toContain('"requests>=2.31"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('matches a name under PEP 503 normalisation', async () => {
    const fixture = await project(
      '[project]\nname = "app"\ndependencies = [\n  "Typing_Extensions>=4.0",\n]\n',
    );
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('typing-extensions', '>=4.10'),
      ]);
      const text = await fixture.read();
      // Typing_Extensions and typing-extensions are one project, so the old
      // entry is replaced rather than duplicated.
      expect(text).toContain('"typing-extensions>=4.10"');
      expect(text).not.toContain('Typing_Extensions');
    } finally {
      await fixture.cleanup();
    }
  });

  it('puts a development dependency in a PEP 735 group', async () => {
    const fixture = await project(PYPROJECT);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('pytest', '>=8', 'development'),
      ]);
      const text = await fixture.read();
      expect(text).toContain('[dependency-groups]');
      expect(text).toContain('dev = ["pytest>=8"]');
      const read = await fixture.format.readRequirements(fixture.detected);
      expect(read).toContainEqual({
        purl: 'pkg:pypi/pytest',
        name: 'pytest',
        range: '>=8',
        scope: 'development',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent', async () => {
    const fixture = await project(PYPROJECT);
    try {
      const reqs = [requirement('requests', '>=2.32')];
      await fixture.format.writeManifest(fixture.detected, reqs);
      const first = await fixture.read();
      const second = await fixture.format.writeManifest(fixture.detected, reqs);
      expect(second.written).toEqual([]);
      expect(await fixture.read()).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });
});
