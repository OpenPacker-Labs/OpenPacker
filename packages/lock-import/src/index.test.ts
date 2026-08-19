import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  detectLockFormat,
  parseRequirementsTxt,
  parsePnpmLock,
  parsePoetryLock,
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
      const item = input.universe.packages.find(
        (candidate) => candidate.identity.exactPurl === purl,
      );
      expect(item).toBeDefined();
      expect(item?.identity.version).toBe(item?.nativeVersion);
      expect(item?.identity.canonicalPurl).not.toContain('@');
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

  it('never fabricates artifact digests for non-sha256 native locks', async () => {
    const nuget = await planLockCapture(nugetAssets, {
      format: 'nuget-assets',
    });
    const golang = await planLockCapture(goSum);
    for (const plan of [nuget, golang]) {
      for (const item of plan.packages) {
        for (const artifact of item.artifacts) {
          expect(artifact.digest.value).not.toBe('0'.repeat(64));
        }
      }
    }
    const withNativeDigest = [...nuget.packages, ...golang.packages].filter(
      (item) =>
        item.semanticLoss.some(
          (loss) => loss.code === 'NATIVE_DIGEST_NOT_REPRESENTED',
        ),
    );
    expect(withNativeDigest.length).toBeGreaterThan(0);
    for (const item of withNativeDigest) expect(item.artifacts).toEqual([]);
  });

  it('captures real sha256 digests from npm integrity fields', async () => {
    const plan = await planLockCapture(npmLock, { format: 'package-lock' });
    const withArtifacts = plan.packages.filter(
      (item) => item.artifacts.length > 0,
    );
    expect(withArtifacts.length).toBeGreaterThan(0);
    for (const item of withArtifacts) {
      expect(item.artifacts[0]?.digest.value).toMatch(/^[0-9a-f]{64}$/);
      expect(item.artifacts[0]?.digest.value).not.toBe('0'.repeat(64));
    }
  });

  it('records lifecycle as unknown instead of claiming published eligibility', async () => {
    const plan = await planLockCapture(npmLock, { format: 'package-lock' });
    for (const item of plan.packages) {
      expect(item.lifecycle.status).toBe('unknown');
      expect(
        item.lifecycle.warnings.some(
          ({ code }) => code === 'LIFECYCLE_NOT_CAPTURED',
        ),
      ).toBe(true);
    }
  });
});

describe('requirements.txt import', () => {
  it('imports a fully pinned file', () => {
    const parsed = parseRequirementsTxt(
      '# comment\nrequests==2.32.3\nidna==3.7\n',
    );
    expect(parsed.package).toEqual([
      { name: 'requests', version: '2.32.3' },
      { name: 'idna', version: '3.7' },
    ]);
  });

  it('refuses artifact hashes instead of silently discarding them', () => {
    expect(() =>
      parseRequirementsTxt('idna==3.7 --hash=sha256:abc --hash=sha256:def\n'),
    ).toThrow(/artifact hash.*losslessly/u);
    // No space before the option: the hash must not slip into the version.
    expect(() => parseRequirementsTxt('idna==3.7--hash=sha256:abc\n')).toThrow(
      /artifact hash.*losslessly/u,
    );
  });

  it('normalises names the way PyPI does', () => {
    // Foo_Bar and foo-bar are the same distribution.
    expect(
      parseRequirementsTxt('Foo_Bar==1.0\nfoo-bar==1.0\n').package,
    ).toEqual([{ name: 'foo-bar', version: '1.0' }]);
    expect(() => parseRequirementsTxt('Foo_Bar==1.0\nfoo-bar==2.0\n')).toThrow(
      /multiple exact versions/u,
    );
  });

  it('refuses anything that is not an exact pin', () => {
    // Importing an unpinned requirements file would produce a pinned universe
    // from an input that never pinned anything.
    for (const bad of ['requests>=2.0', 'requests', 'requests~=2.0'])
      expect(() => parseRequirementsTxt(bad), bad).toThrow(/exact pin/u);
    for (const directive of ['-e .', '-r extra.txt', '-c constraints.txt'])
      expect(
        () => parseRequirementsTxt(`requests==2.32.3\n${directive}\n`),
        directive,
      ).toThrow(/option or include.*losslessly/u);
  });

  it('is detected only when every line is a pin', () => {
    expect(detectLockFormat('requests==2.32.3\nidna==3.7\n')).toBe(
      'requirements-txt',
    );
    // A loose test here would claim any text file is a requirements.txt.
    expect(() => detectLockFormat('requests>=2.0\n')).toThrow(/detect/u);
  });
});

describe('pnpm-lock.yaml import', () => {
  const lock = (body: string) => `lockfileVersion: '9.0'\npackages:\n${body}`;

  it('splits scoped names on the last @, not the first', () => {
    // `@scope/pkg@1.2.3` carries two @; splitting on the first would name the
    // package "" at version "scope/pkg@1.2.3".
    const parsed = parsePnpmLock(
      lock("  '@scope/pkg@1.2.3':\n    resolution: {integrity: sha512-x}\n"),
    );
    expect(parsed.packages['node_modules/@scope/pkg']?.version).toBe('1.2.3');
  });

  it('refuses peer contexts and multiple locked versions', () => {
    expect(() =>
      parsePnpmLock(
        lock(
          "  'react-dom@18.2.0(react@18.2.0)':\n    resolution: {integrity: sha512-y}\n",
        ),
      ),
    ).toThrow(/peer context.*losslessly/u);
    expect(() =>
      parsePnpmLock(
        "lockfileVersion: '9.0'\npackages:\n  'react-dom@18.2.0': {}\nsnapshots:\n  'react-dom@18.2.0(react@18.2.0)': {}\n",
      ),
    ).toThrow(/peer context.*losslessly/u);
    expect(() =>
      parsePnpmLock(lock("  'a@1.0.0': {}\n  'a@2.0.0': {}\n")),
    ).toThrow(/multiple locked selections/u);
  });

  it('refuses pre-v9 lockfiles, whose keys mean something else', () => {
    for (const version of ['5.4', '6.0', '8.0'])
      expect(() =>
        parsePnpmLock(
          `lockfileVersion: '${version}'\npackages:\n  /a@1.0.0: {}\n`,
        ),
      ).toThrow(/only version 9/u);
  });

  it('refuses malformed entries even when another package is valid', () => {
    expect(() =>
      parsePnpmLock(lock("  'a@1.0.0': {}\n  local-package: {}\n")),
    ).toThrow(/unsupported package key/u);
  });

  it('refuses malformed package values instead of importing them version-only', () => {
    expect(() => parsePnpmLock(lock("  'a@1.0.0': garbage\n"))).toThrow(
      /malformed package value/u,
    );
    expect(() =>
      parsePnpmLock(lock("  'a@1.0.0':\n    resolution: garbage\n")),
    ).toThrow(/malformed resolution/u);
    expect(() =>
      parsePnpmLock(lock("  'a@1.0.0':\n    resolution: {integrity: 42}\n")),
    ).toThrow(/malformed resolution/u);
  });

  it('does not auto-detect pre-v9 lockfiles as pnpm', () => {
    // Only the v9 key shape is supported; a v6 file must fall through to
    // unable-to-detect rather than being parsed with v9 semantics.
    expect(() =>
      detectLockFormat("lockfileVersion: '6.0'\npackages:\n  /a@1.0.0: {}\n"),
    ).toThrow(/detect/u);
  });

  it('refuses malformed or unbound snapshot selections', () => {
    for (const snapshots of [
      "['react-dom@18.2.0(react@18.2.0)']",
      "'react-dom@18.2.0(react@18.2.0)'",
    ])
      expect(() =>
        parsePnpmLock(
          `lockfileVersion: '9.0'\npackages:\n  'react-dom@18.2.0': {}\nsnapshots: ${snapshots}\n`,
        ),
      ).toThrow(/snapshots must be a mapping/u);
    expect(() =>
      parsePnpmLock(
        "lockfileVersion: '9.0'\npackages:\n  'a@1.0.0': {}\nsnapshots:\n  'a@1.0.0': {}\n  local-malformed: {}\n",
      ),
    ).toThrow(/unsupported package key/u);
    expect(() =>
      parsePnpmLock(
        "lockfileVersion: '9.0'\npackages:\n  'a@1.0.0': {}\nsnapshots:\n  'b@1.0.0': {}\n",
      ),
    ).toThrow(/no matching package/u);
  });

  it('is detected from its version and packages sections', () => {
    expect(
      detectLockFormat(
        lock("  'a@1.0.0':\n    resolution: {integrity: sha512-z}\n"),
      ),
    ).toBe('pnpm-lock');
  });
});

describe('poetry.lock import', () => {
  const poetry = `[[package]]\nname = "Foo_Bar"\nversion = "1.0"\n\n[metadata]\nlock-version = "2.0"\n`;

  it('normalises names the way PyPI does', () => {
    expect(parsePoetryLock(poetry).package).toEqual([
      { name: 'foo-bar', version: '1.0' },
    ]);
  });

  it('refuses duplicate, marker, source, and hash context', () => {
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\n\n[[package]]\nname = "Foo"\nversion = "2.0"\n`,
      ),
    ).toThrow(/multiple locked selections/u);
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\nmarker = "sys_platform == 'linux'"\n`,
      ),
    ).toThrow(/context.*losslessly/u);
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\n\n[package.dependencies]\ndep = { version = "1", markers = "sys_platform == 'win32'" }\n`,
      ),
    ).toThrow(/context.*losslessly/u);
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\nsource = { type = "git", url = "https://example.invalid/repo" }\n`,
      ),
    ).toThrow(/context.*losslessly/u);
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\n\n[metadata.files]\nfoo = [{ file = "foo.whl", hash = "sha256:abc" }]\n`,
      ),
    ).toThrow(/artifact hashes.*integrity/u);
  });

  it('is distinguished from Cargo.lock, which also uses [[package]]', () => {
    // The [metadata] lock-version block is what separates them.
    expect(detectLockFormat(poetry)).toBe('poetry-lock');
    expect(
      detectLockFormat(
        'version = 3\n\n[[package]]\nname = "a"\nversion = "1.0"\n',
      ),
    ).toBe('cargo-lock');
  });

  it('refuses a file with no importable packages', () => {
    expect(() => parsePoetryLock('[metadata]\nlock-version = "2.0"\n')).toThrow(
      /\[\[package\]\]/u,
    );
  });

  it('refuses malformed entries even when another package is valid', () => {
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "good"\nversion = "1.0"\n\n[[package]]\nname = "missing-version"\n`,
      ),
    ).toThrow(/missing a string name or version/u);
  });

  it('refuses names that do not normalise to a PyPI distribution name', () => {
    expect(() =>
      parsePoetryLock(`[[package]]\nname = "-foo"\nversion = "1.0"\n`),
    ).toThrow(/invalid name/u);
    expect(() =>
      parsePoetryLock(`[[package]]\nname = "!!!"\nversion = "1.0"\n`),
    ).toThrow(/invalid name/u);
  });

  it('refuses per-entry python-versions and optional selections', () => {
    // python-versions is environment applicability: dropping it would pin a
    // selection for interpreters the lock never covered.
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\npython-versions = ">=3.6"\n`,
      ),
    ).toThrow(/context.*losslessly/u);
    // optional = true means the package may not participate in the locked set.
    expect(() =>
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\noptional = true\n`,
      ),
    ).toThrow(/context.*losslessly/u);
    // optional = false is the poetry default and carries no information.
    expect(
      parsePoetryLock(
        `[[package]]\nname = "foo"\nversion = "1.0"\noptional = false\n`,
      ).package,
    ).toEqual([{ name: 'foo', version: '1.0' }]);
  });

  it('surfaces [metadata] python-versions as tracked requires-python loss', async () => {
    const parsed = parsePoetryLock(
      `[[package]]\nname = "foo"\nversion = "1.0"\n\n[metadata]\nlock-version = "2.0"\npython-versions = "^3.10"\n`,
    );
    expect(parsed['requires-python']).toBe('^3.10');
    const plan = await planLockCapture(
      `[[package]]\nname = "foo"\nversion = "1.0"\n\n[metadata]\nlock-version = "2.0"\npython-versions = "^3.10"\n`,
    );
    expect(
      plan.semanticLoss.some(
        (loss) => loss.code === 'PYPI_LOCK_REQUIRES_PYTHON',
      ),
    ).toBe(true);
  });
});
