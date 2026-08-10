import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { GolangProjectFormat } from './project.js';

const GO_MOD = `module example.com/app

go 1.22

require (
	github.com/google/uuid v1.6.0
)
`;

async function project(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'go-project-'));
  await writeFile(join(dir, 'go.mod'), contents);
  const format = new GolangProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected');
  return {
    format,
    detected,
    read: () => readFile(join(dir, 'go.mod'), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({
  purl: `pkg:golang/${name}`,
  name,
  range,
  scope,
});

describe('GolangProjectFormat', () => {
  it('updates a require without touching module or go directives', async () => {
    const fixture = await project(GO_MOD);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('github.com/google/uuid', 'v1.6.1'),
      ]);
      const text = await fixture.read();
      expect(text).toContain('github.com/google/uuid v1.6.1');
      expect(text).toContain('module example.com/app');
      expect(text).toContain('go 1.22');
    } finally {
      await fixture.cleanup();
    }
  });

  it('adds a new require inside the existing block', async () => {
    const fixture = await project(GO_MOD);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('github.com/google/uuid', 'v1.6.0'),
        requirement('golang.org/x/sync', 'v0.7.0'),
      ]);
      const text = await fixture.read();
      expect(text.match(/require \(/gu)).toHaveLength(1);
      expect(text).toContain('\tgolang.org/x/sync v0.7.0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('prefixes a bare version so go.mod stays valid', async () => {
    const fixture = await project(GO_MOD);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('golang.org/x/sync', '0.7.0'),
      ]);
      expect(await fixture.read()).toContain('golang.org/x/sync v0.7.0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports loss instead of writing a development dependency', async () => {
    const fixture = await project(GO_MOD);
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('github.com/stretchr/testify', 'v1.9.0', 'development'),
      ]);
      expect(result.semanticLoss[0]?.code).toBe('NATIVE_SCOPE_UNSUPPORTED');
      expect(await fixture.read()).not.toContain('testify');
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent', async () => {
    const fixture = await project(GO_MOD);
    try {
      const reqs = [requirement('github.com/google/uuid', 'v1.6.1')];
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
