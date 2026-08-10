import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { CargoProjectFormat } from './project.js';

const CARGO_TOML = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

# Comment that must survive.
[dependencies]
serde = "1.0"

[dev-dependencies]
`;

async function project(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cargo-project-'));
  await writeFile(join(dir, 'Cargo.toml'), contents);
  const format = new CargoProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected');
  return {
    format,
    detected,
    read: () => readFile(join(dir, 'Cargo.toml'), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({ purl: `pkg:cargo/${name}`, name, range, scope });

describe('CargoProjectFormat', () => {
  it('updates a dependency and keeps the comment and package table', async () => {
    const fixture = await project(CARGO_TOML);
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('serde', '1.0.200'),
      ]);
      expect(result.written).toHaveLength(1);
      const text = await fixture.read();
      expect(text).toContain('serde = "1.0.200"');
      expect(text).toContain('# Comment that must survive.');
      expect(text).toContain('edition = "2021"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('puts a development dependency in dev-dependencies, not dependencies', async () => {
    const fixture = await project(CARGO_TOML);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('proptest', '1.4', 'development'),
      ]);
      const read = await fixture.format.readRequirements(fixture.detected);
      expect(read).toContainEqual({
        purl: 'pkg:cargo/proptest',
        name: 'proptest',
        range: '1.4',
        scope: 'development',
      });
      const text = await fixture.read();
      // Only the [dependencies] table, not everything after its header.
      const runtimeTable = text.slice(
        text.indexOf('[dependencies]'),
        text.indexOf('[dev-dependencies]'),
      );
      expect(runtimeTable).not.toContain('proptest');
    } finally {
      await fixture.cleanup();
    }
  });

  it('moves a dependency out of its old table when its scope changes', async () => {
    const fixture = await project(CARGO_TOML);
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('serde', '1.0', 'development'),
      ]);
      const read = await fixture.format.readRequirements(fixture.detected);
      // Two copies would let cargo build with one and test with the other.
      expect(read.filter((entry) => entry.name === 'serde')).toHaveLength(1);
      expect(read[0]?.scope).toBe('development');
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent', async () => {
    const fixture = await project(CARGO_TOML);
    try {
      const reqs = [requirement('serde', '1.0.200')];
      await fixture.format.writeManifest(fixture.detected, reqs);
      const first = await fixture.read();
      const second = await fixture.format.writeManifest(fixture.detected, reqs);
      expect(second.written).toEqual([]);
      expect(await fixture.read()).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports loss for a scope Cargo has no table for', async () => {
    const fixture = await project(CARGO_TOML);
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('react', '18', 'peer'),
      ]);
      expect(result.semanticLoss[0]?.code).toBe('NATIVE_SCOPE_UNSUPPORTED');
    } finally {
      await fixture.cleanup();
    }
  });
});
