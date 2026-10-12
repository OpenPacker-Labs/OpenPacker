import { describe, expect, it } from 'vitest';
import { PnpmLockError } from './errors.js';
import {
  MAXIMUM_REPORTED_PROBLEMS,
  assertConsistentPnpmLock,
  readPnpmLock,
  validatePnpmLock,
} from './index.js';
import { parsePnpmLock } from './parse.js';
import { BASE, SHA512, edit } from './read-support.test-helpers.js';
import type { PnpmLockProblemCode } from './validate.js';

const report = (text: string) => validatePnpmLock(parsePnpmLock(text));
const codes = (text: string): PnpmLockProblemCode[] =>
  report(text).problems.map((problem) => problem.code);
/** BASE with no `snapshots` section at all, which is how pnpm writes a lock with none. */
const noSnapshots = () => BASE.slice(0, BASE.indexOf('\nsnapshots:'));
const pkgEntry = (key: string, extra = '') =>
  `  ${key}:\n    resolution: {integrity: ${SHA512}}${extra}\n`;

/** BASE plus whole extra entries in `packages` and `snapshots`. */
function withEntries(packages: string, snapshots: string): string {
  return edit(
    edit(BASE, '\nsnapshots:', `${packages}\nsnapshots:`),
    '  a@1.0.0: {}\n',
    `  a@1.0.0: {}\n${snapshots}`,
  );
}

describe('validatePnpmLock: a lock that agrees with itself', () => {
  it('has no problem, no orphan, no exotic source and no link', () => {
    expect(report(BASE)).toEqual({
      problems: [],
      problemCount: 0,
      orphanPackages: [],
      orphanSnapshots: [],
      exoticSources: [],
      links: [],
    });
    expect(readPnpmLock(BASE).lock.packages).toHaveLength(1);
  });
});

describe('validatePnpmLock: dependencies that do not resolve', () => {
  it('names an importer dependency whose snapshot is missing, and the package left without a snapshot', () => {
    const found = report(noSnapshots());
    expect(found.problems).toEqual([
      {
        code: 'importer-dependency-unresolved',
        where: 'importers["."]["a"]',
        message: 'resolves to "a@1.0.0", which is not in snapshots',
      },
    ]);
    expect(found.orphanPackages).toEqual(['a@1.0.0']);
  });

  it('names a snapshot dependency whose snapshot is missing', () => {
    const text = edit(
      BASE,
      '  a@1.0.0: {}\n',
      '  a@1.0.0:\n    dependencies:\n      b: 2.0.0\n',
    );
    expect(codes(text)).toEqual(['snapshot-dependency-unresolved']);
    expect(report(text).problems[0]?.where).toBe('snapshots["a@1.0.0"]["b"]');
  });

  it('follows an alias to the package it names, and a peer suffix to its own snapshot', () => {
    const text = withEntries(
      pkgEntry('real@2.0.0') + pkgEntry('p@1.0.0'),
      '  real@2.0.0: {}\n  p@1.0.0(a@1.0.0): {}\n',
    );
    const wired = edit(
      text,
      '        version: 1.0.0\n',
      '        version: 1.0.0\n      other:\n        specifier: npm:real@2\n        version: real@2.0.0\n      p:\n        specifier: ^1.0.0\n        version: 1.0.0(a@1.0.0)\n',
    );
    expect(codes(wired)).toEqual([]);
    const dangling = edit(wired, 'version: real@2.0.0', 'version: real@3.0.0');
    expect(codes(dangling)).toEqual(['importer-dependency-unresolved']);
  });

  it('names a snapshot with no package, and does not count it as reached', () => {
    const text = edit(
      BASE,
      '  a@1.0.0: {}\n',
      '  a@1.0.0: {}\n  b@1.0.0: {}\n',
    );
    const found = report(text);
    expect(found.problems.map((p) => p.code)).toEqual([
      'snapshot-without-package',
    ]);
    expect(found.orphanSnapshots).toEqual(['b@1.0.0']);
  });
});

describe('validatePnpmLock: orphans', () => {
  it('lists a package no snapshot is a variant of, and a snapshot no importer reaches', () => {
    const text = withEntries(
      pkgEntry('b@1.0.0') + pkgEntry('c@1.0.0'),
      '  c@1.0.0: {}\n',
    );
    const found = report(text);
    expect(found.problemCount).toBe(0);
    expect(found.orphanPackages).toEqual(['b@1.0.0']);
    expect(found.orphanSnapshots).toEqual(['c@1.0.0']);
  });

  it('reaches through dependencies, optional dependencies and aliases, but not through a link', () => {
    const text = withEntries(
      pkgEntry('b@1.0.0') + pkgEntry('c@1.0.0') + pkgEntry('d@1.0.0'),
      '  b@1.0.0:\n    optionalDependencies:\n      c: 1.0.0\n  c@1.0.0:\n    dependencies:\n      e: d@1.0.0\n  d@1.0.0: {}\n',
    );
    const wired = edit(
      text,
      '  a@1.0.0: {}\n',
      '  a@1.0.0:\n    dependencies:\n      b: 1.0.0\n',
    );
    const found = report(wired);
    expect(found.problems).toEqual([]);
    expect(found.orphanSnapshots).toEqual([]);
  });
});

describe('validatePnpmLock: a resolution that is not the key', () => {
  const GIT = '0123456789abcdef0123456789abcdef01234567';
  const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
  /** A git package whose key names `keyCommit` while its resolution fetches `resolutionCommit` from `repo`. */
  const gitLock = (
    keyCommit: string,
    resolutionCommit: string,
    repo = 'https://h/g.git',
  ) => {
    // pnpm writes the id with https:// in front of an address that has no scheme.
    const id = `git+${repo.includes('://') ? '' : 'https://'}${repo}#${keyCommit}`;
    return `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      g:\n        specifier: x\n        version: ${id}\n\npackages:\n\n  g@${id}:\n    resolution: {commit: ${resolutionCommit}, repo: ${repo}, type: git}\n    version: 1.0.0\n\nsnapshots:\n\n  g@${id}: {}\n`;
  };

  it('accepts a git key that is the resolution it names', () => {
    expect(codes(gitLock(GIT, GIT))).toEqual([]);
    expect(codes(gitLock(GIT, GIT, 'git@github.com:o/r.git'))).toEqual([]);
  });

  it('refuses a git key that names one commit while the resolution fetches another', () => {
    const found = report(gitLock(GIT, OTHER));
    expect(found.problems.map((p) => p.code)).toEqual([
      'resolution-source-mismatch',
    ]);
    expect(found.problems[0]?.message).toContain(OTHER);
  });

  it.each([
    ['a registry key with a directory', '{directory: ../a, type: directory}'],
    [
      'a registry key with a git resolution',
      `{commit: ${GIT}, repo: "https://h/a.git", type: git}`,
    ],
    ['a registry key with variations', '{type: variations, variants: []}'],
  ])('refuses %s', (_label, resolution) => {
    expect(codes(edit(BASE, `{integrity: ${SHA512}}`, resolution))).toEqual([
      'resolution-source-mismatch',
    ]);
  });

  it('refuses a tarball URL key with only an integrity, and a file key with a git resolution', () => {
    const url = 'https://h/a.tgz';
    const tarballKey = BASE.replaceAll('a@1.0.0', `a@${url}`).replace(
      'version: 1.0.0',
      `version: ${url}`,
    );
    expect(codes(tarballKey)).toEqual(['resolution-source-mismatch']);
    const fileKey = BASE.replaceAll('a@1.0.0', 'a@file:../a').replace(
      'version: 1.0.0',
      'version: file:../a',
    );
    expect(codes(fileKey)).toEqual(['resolution-source-mismatch']);
    expect(
      codes(
        edit(
          fileKey,
          `{integrity: ${SHA512}}`,
          '{directory: ../a, type: directory}',
        ),
      ),
    ).toEqual([]);
  });
});

describe('validatePnpmLock: specifiers', () => {
  it('names a dependency listed under two specifiers, and accepts one listed twice with the same', () => {
    const twice = (second: string) =>
      edit(
        BASE,
        '    dependencies:\n',
        `    devDependencies:\n      a:\n        specifier: ${second}\n        version: 1.0.0\n    dependencies:\n`,
      );
    expect(codes(twice('^1.0.0'))).toEqual([]);
    expect(codes(twice('~1.0.0'))).toEqual(['conflicting-specifiers']);
  });

  it('names a workspace: specifier that resolved to a registry package, and accepts a link or an injected file:', () => {
    const wanted = edit(BASE, 'specifier: ^1.0.0', 'specifier: workspace:*');
    expect(codes(wanted)).toEqual(['workspace-specifier-not-linked']);
    expect(codes(edit(wanted, 'version: 1.0.0', 'version: link:../a'))).toEqual(
      [],
    );
  });

  it('names a catalog: specifier whose catalog has no entry, and accepts one that has', () => {
    const wanted = edit(BASE, 'specifier: ^1.0.0', "specifier: 'catalog:'");
    expect(codes(wanted)).toEqual(['catalog-entry-missing']);
    const catalog = (name: string, dep: string) =>
      edit(
        wanted,
        "lockfileVersion: '9.0'\n",
        `lockfileVersion: '9.0'\n\ncatalogs:\n  ${name}:\n    ${dep}:\n      specifier: ^1.0.0\n      version: 1.0.0\n`,
      );
    expect(codes(catalog('default', 'a'))).toEqual([]);
    expect(codes(catalog('default', 'z'))).toEqual(['catalog-entry-missing']);
    expect(codes(catalog('other', 'a'))).toEqual(['catalog-entry-missing']);
    expect(
      codes(
        edit(
          catalog('named', 'a'),
          "specifier: 'catalog:'\n",
          'specifier: catalog:named\n',
        ),
      ),
    ).toEqual([]);
  });
});

describe('validatePnpmLock: patches', () => {
  const patched = (hash: string, declared: string | undefined) => {
    const base = edit(
      edit(BASE, '  a@1.0.0: {}', '  a@1.0.0(patch_hash=abc123): {}'),
      'version: 1.0.0',
      'version: 1.0.0(patch_hash=abc123)',
    );
    return declared === undefined
      ? base
      : edit(
          base,
          "lockfileVersion: '9.0'\n",
          `lockfileVersion: '9.0'\n\npatchedDependencies:\n  ${declared}:\n    hash: ${hash}\n    path: patches/a.patch\n`,
        );
  };

  it('accepts a patch declared with the hash the snapshot carries, by exact key, by name or by range', () => {
    expect(codes(patched('abc123', 'a@1.0.0'))).toEqual([]);
    expect(codes(patched('abc123', 'a'))).toEqual([]);
    expect(codes(patched('other', 'a@^1.0.0'))).toEqual([]);
  });

  it('names a patch_hash with no declaration, a hash that differs, and a patch for nothing installed', () => {
    expect(codes(patched('abc123', undefined))).toEqual(['patch-undeclared']);
    expect(codes(patched('different', 'a@1.0.0'))).toEqual([
      'patch-hash-mismatch',
    ]);
    expect(
      codes(
        edit(patched('abc123', 'a@1.0.0'), "'9.0'\n", "'9.0'\n\n").replace(
          'a@1.0.0:\n    hash',
          'zzz@1.0.0:\n    hash',
        ),
      ),
    ).toContain('patch-unused');
  });
});

describe('validatePnpmLock: links', () => {
  /** Importers `ids` (empty) and `from`, which links `x` to `target`. */
  const linked = (ids: string[], target: string, from = '.') => {
    const others = ids.filter((id) => id !== from);
    const empty = others.map((id) => `  ${id}: {}\n`).join('\n');
    return `lockfileVersion: '9.0'\n\nimporters:\n\n${empty}\n  ${from}:\n    dependencies:\n      x:\n        specifier: workspace:*\n        version: link:${target}\n`;
  };

  it('places an importer link on the member it lands on', () => {
    expect(report(linked(['packages/x'], 'packages/x')).links).toEqual([
      {
        owner: 'importer',
        id: '.',
        name: 'x',
        target: 'packages/x',
        resolved: 'packages/x',
        member: true,
      },
    ]);
    expect(
      report(linked(['packages/x', 'packages/y'], '../x', 'packages/y'))
        .links[0],
    ).toMatchObject({
      id: 'packages/y',
      resolved: 'packages/x',
      member: true,
    });
  });

  it('says a link to a directory that is no importer is not a member, and one that leaves the root has no place', () => {
    expect(report(linked([], 'vendor/x')).links[0]).toMatchObject({
      resolved: 'vendor/x',
      member: false,
    });
    const out = report(linked([], '../../../x', 'packages/y')).links[0];
    expect(out).toMatchObject({ target: '../../../x' });
    expect(out).not.toHaveProperty('resolved');
    expect(report(linked([], '.', 'packages/y')).links[0]).toMatchObject({
      resolved: 'packages/y',
    });
  });

  it('lists a snapshot link without placing it', () => {
    const text = edit(
      BASE,
      '  a@1.0.0: {}\n',
      '  a@1.0.0:\n    dependencies:\n      b: link:../b\n',
    );
    expect(report(text).links).toEqual([
      { owner: 'snapshot', id: 'a@1.0.0', name: 'b', target: '../b' },
    ]);
    expect(codes(text)).toEqual([]);
  });
});

describe('validatePnpmLock: the report is bounded', () => {
  it('counts every problem and keeps the first thousand', () => {
    const count = MAXIMUM_REPORTED_PROBLEMS + 50;
    const deps = Array.from(
      { length: count },
      (_, i) =>
        `      d${String(i).padStart(5, '0')}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`,
    ).join('');
    const text = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${deps}`;
    const found = report(text);
    expect(found.problemCount).toBe(count);
    expect(found.problems).toHaveLength(MAXIMUM_REPORTED_PROBLEMS);
    expect(found.problems[0]?.where).toBe('importers["."]["d00000"]');
  });
});

describe('assertConsistentPnpmLock and readPnpmLock', () => {
  const broken = noSnapshots();

  it('refuses a lock with a problem, naming it', () => {
    let error: unknown;
    try {
      readPnpmLock(broken);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PnpmLockError);
    expect((error as PnpmLockError).reason).toBe('inconsistent');
    expect((error as PnpmLockError).message).toContain('importers["."]["a"]');
    expect((error as PnpmLockError).message).toContain('in 1 place:');
  });

  it('shows five problems and counts the rest', () => {
    const many = Array.from(
      { length: 8 },
      (_, i) =>
        `      d${i}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`,
    ).join('');
    const text = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${many}`;
    expect(() => assertConsistentPnpmLock(report(text))).toThrow(
      /in 8 places:.*, and 3 more/u,
    );
  });

  it('lets a lock with orphans through', () => {
    const text = withEntries(pkgEntry('b@1.0.0'), '');
    expect(() => readPnpmLock(text)).not.toThrow();
  });
});
