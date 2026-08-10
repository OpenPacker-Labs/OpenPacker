import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { MavenProjectFormat } from './project.js';

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>

  <!-- Load-bearing comment. -->
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.0.0-jre</version>
    </dependency>
  </dependencies>
</project>
`;

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'maven-project-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  const format = new MavenProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected');
  return {
    dir,
    format,
    detected,
    read: (name: string) => readFile(join(dir, name), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({
  purl: `pkg:maven/${name.replace(':', '/')}`,
  name,
  range,
  scope,
});

describe('MavenProjectFormat — pom.xml', () => {
  it('updates a version without disturbing the rest of the pom', async () => {
    const fixture = await project({ 'pom.xml': POM });
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('com.google.guava:guava', '33.0.0-jre'),
      ]);
      expect(result.written).toEqual([fixture.detected.manifestPath]);
      const text = await fixture.read('pom.xml');
      expect(text).toContain('<version>33.0.0-jre</version>');
      expect(text).toContain('<!-- Load-bearing comment. -->');
      expect(text).toContain('<artifactId>app</artifactId>');
    } finally {
      await fixture.cleanup();
    }
  });

  it('adds a test-scoped dependency and reads the scope back', async () => {
    const fixture = await project({ 'pom.xml': POM });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('org.junit.jupiter:junit-jupiter', '5.10.0', 'development'),
      ]);
      const text = await fixture.read('pom.xml');
      expect(text).toContain('<scope>test</scope>');
      const read = await fixture.format.readRequirements(fixture.detected);
      expect(read).toContainEqual({
        purl: 'pkg:maven/org.junit.jupiter/junit-jupiter',
        name: 'org.junit.jupiter:junit-jupiter',
        range: '5.10.0',
        scope: 'development',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent', async () => {
    const fixture = await project({ 'pom.xml': POM });
    try {
      const reqs = [requirement('com.google.guava:guava', '33.0.0-jre')];
      await fixture.format.writeManifest(fixture.detected, reqs);
      const first = await fixture.read('pom.xml');
      const second = await fixture.format.writeManifest(fixture.detected, reqs);
      expect(second.written).toEqual([]);
      expect(await fixture.read('pom.xml')).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses a PURL that names only half a Maven coordinate', async () => {
    const fixture = await project({ 'pom.xml': POM });
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        { purl: 'pkg:maven/guava', name: 'guava', scope: 'runtime' },
      ]);
      expect(result.semanticLoss[0]?.code).toBe('NATIVE_COORDINATE_INCOMPLETE');
      expect(result.written).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('MavenProjectFormat — Gradle', () => {
  it('writes the version catalog when the project has one', async () => {
    const fixture = await project({
      'gradle/libs.versions.toml':
        '[versions]\nkotlin = "2.0.0"\n\n[libraries]\n',
      'build.gradle.kts': 'plugins { kotlin("jvm") }\n',
    });
    try {
      expect(fixture.detected.metadata?.kind).toBe('gradle-catalog');
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('com.google.guava:guava', '33.0.0-jre'),
      ]);
      const catalog = await fixture.read('gradle/libs.versions.toml');
      expect(catalog).toContain(
        'com-google-guava-guava = { module = "com.google.guava:guava", version = "33.0.0-jre" }',
      );
      // The catalog declares the library; wiring it into a configuration is
      // still the build script's job, and that is said out loud.
      expect(result.semanticLoss.map((loss) => loss.code)).toContain(
        'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
      );
      expect(await fixture.read('build.gradle.kts')).toBe(
        'plugins { kotlin("jvm") }\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses to edit a build script and says why', async () => {
    const fixture = await project({
      'build.gradle.kts':
        'dependencies {\n  implementation("com.google.guava:guava:32.0.0-jre")\n}\n',
    });
    try {
      expect(fixture.detected.metadata?.kind).toBe('gradle-script');
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('com.google.guava:guava', '33.0.0-jre'),
      ]);
      expect(result.written).toEqual([]);
      expect(result.semanticLoss[0]?.code).toBe('NATIVE_MANIFEST_NOT_WRITABLE');
      // A build script is a program. Editing it as if it were a list is how a
      // dependency ends up added twice, or inside the wrong block.
      expect(await fixture.read('build.gradle.kts')).toContain('32.0.0-jre');
    } finally {
      await fixture.cleanup();
    }
  });
});
