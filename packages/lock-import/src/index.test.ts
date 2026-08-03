import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  detectLockFormat,
  planLockCapture,
  planNativeLockImport,
} from './index.js';

const npmLock = await readFile(
  new URL('../../../fixtures/locks/npm/package-lock.json', import.meta.url),
  'utf8',
);
const cargoLock = await readFile(
  new URL('../../../fixtures/locks/cargo/Cargo.lock', import.meta.url),
  'utf8',
);
const nugetAssets = await readFile(
  new URL('../../../fixtures/locks/nuget/project.assets.json', import.meta.url),
  'utf8',
);
const uvLock = await readFile(
  new URL('../../../fixtures/locks/pypi/uv.lock.json', import.meta.url),
  'utf8',
);
const goSum = await readFile(
  new URL('../../../fixtures/locks/golang/go.sum', import.meta.url),
  'utf8',
);
const gradleLock = await readFile(
  new URL('../../../fixtures/locks/maven/gradle.lockfile', import.meta.url),
  'utf8',
);

describe('lock-import planning', () => {
  it('detects fixture formats', () => {
    expect(detectLockFormat(npmLock)).toBe('package-lock');
    expect(detectLockFormat(cargoLock)).toBe('cargo-lock');
    expect(detectLockFormat(nugetAssets)).toBe('nuget-assets');
    expect(detectLockFormat(uvLock)).toBe('uv-lock');
    expect(detectLockFormat(goSum)).toBe('go-sum');
    expect(detectLockFormat(gradleLock)).toBe('gradle-lockfile');
  });

  it('captures npm package-lock into locked exact PURLs', async () => {
    const plan = await planLockCapture(npmLock, { format: 'package-lock' });
    expect(plan.ecosystem).toBe('npm');
    expect(plan.lockedExactPurls).toContain(
      'pkg:npm/%40openpacker/demo-tool@1.1.0',
    );
    expect(
      plan.semanticLoss.some(
        (loss) => loss.code === 'NATIVE_RESULT_CAPTURE_ONLY',
      ),
    ).toBe(true);
  });

  it('builds a native-capture solve request for Cargo.lock', async () => {
    const input = await planNativeLockImport(cargoLock);
    expect(input.request.semantics.profile).toBe('native-capture-v1');
    expect(input.request.environment.locked).toEqual(
      expect.arrayContaining([
        'pkg:cargo/demo-zstd@1.0.0',
        'pkg:cargo/cfg-if@1.0.0',
      ]),
    );
    expect(input.universe.packages).toHaveLength(2);
    for (const purl of input.request.environment.locked) {
      expect(
        input.universe.packages.some(
          (item) => item.identity.exactPurl === purl,
        ),
      ).toBe(true);
    }
  });

  it('captures nuget project.assets.json selections', async () => {
    const plan = await planLockCapture(nugetAssets, {
      format: 'nuget-assets',
    });
    expect(plan.ecosystem).toBe('nuget');
    expect(plan.lockedExactPurls.length).toBeGreaterThan(0);
    expect(
      plan.lockedExactPurls.every((purl) => purl.startsWith('pkg:nuget/')),
    ).toBe(true);
  });

  it('captures uv.lock, go.sum, and gradle.lockfile selections', async () => {
    const pypi = await planLockCapture(uvLock);
    expect(pypi.ecosystem).toBe('pypi');
    expect(
      pypi.lockedExactPurls.some((purl) => purl.startsWith('pkg:pypi/')),
    ).toBe(true);

    const golang = await planLockCapture(goSum);
    expect(golang.ecosystem).toBe('golang');
    expect(
      golang.lockedExactPurls.some((purl) => purl.startsWith('pkg:golang/')),
    ).toBe(true);

    const maven = await planLockCapture(gradleLock);
    expect(maven.ecosystem).toBe('maven');
    expect(
      maven.lockedExactPurls.some((purl) => purl.startsWith('pkg:maven/')),
    ).toBe(true);
  });
});
