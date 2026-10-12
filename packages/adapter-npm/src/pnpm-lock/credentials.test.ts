/**
 * A credential in an address must stay out of every message the reader raises or
 * reports, wherever the address sits: a key, a dependency value, a resolution,
 * a peer group, a path to the failure. The reader refuses such an address so the
 * secret stays out of log lines; a message that quotes it defeats that.
 */

import { describe, expect, it } from 'vitest';
import { PnpmLockError } from './errors.js';
import { parsePnpmLock } from './parse.js';
import { BASE, SHA512, edit, refusalOf } from './read-support.test-helpers.js';
import { assertConsistentPnpmLock, validatePnpmLock } from './validate.js';

/** Dummy value shaped like a token; a prefix of it leaking is a leak too. */
const MARKER = 'vtok_dummy_marker_0123456789abcdef';
const LEAK = 'vtok_dummy';
const COMMIT = 'a'.repeat(40);
const TARBALL_WITH_PASSWORD = `https://user:${MARKER}@h.example/a.tgz`;

const quote = (key: string) => `'${key}'`;
const packageKey = (key: string) =>
  edit(BASE, '  a@1.0.0:\n    resolution', `  ${quote(key)}:\n    resolution`);
const snapshotKey = (key: string) =>
  edit(BASE, '  a@1.0.0: {}', `  ${quote(key)}: {}`);
const snapshotDependency = (value: string) =>
  edit(
    BASE,
    '  a@1.0.0: {}',
    `  a@1.0.0:\n    dependencies:\n      b: ${quote(value)}`,
  );
const importerVersion = (value: string) =>
  edit(BASE, 'version: 1.0.0', `version: ${quote(value)}`);
const resolution = (flow: string) => edit(BASE, `{integrity: ${SHA512}}`, flow);

const CASES: readonly (readonly [label: string, text: string])[] = [
  ['a packages key with a password', packageKey(`a@${TARBALL_WITH_PASSWORD}`)],
  [
    'a packages key with a token as the user',
    packageKey(`a@git+https://${MARKER}@h.example/r.git#${COMMIT}`),
  ],
  [
    'a packages key with a password over ssh',
    packageKey(`a@git+ssh://git:${MARKER}@h.example/r.git#${COMMIT}`),
  ],
  [
    'a packages key that starts with the address, so the "name" is a URL',
    packageKey(`https://user:${MARKER}@h.example/a.tgz@1.0.0`),
  ],
  ['a snapshots key', snapshotKey(`a@${TARBALL_WITH_PASSWORD}`)],
  [
    'a snapshots key with the address in a peer group',
    snapshotKey(`a@1.0.0(b@${TARBALL_WITH_PASSWORD})`),
  ],
  [
    'a snapshot dependency value',
    snapshotDependency(`b@${TARBALL_WITH_PASSWORD}`),
  ],
  ['an importer version', importerVersion(TARBALL_WITH_PASSWORD)],
  [
    'a catalog entry version',
    edit(
      BASE,
      'importers:',
      `catalogs:\n  default:\n    a:\n      specifier: ^1.0.0\n      version: ${quote(TARBALL_WITH_PASSWORD)}\n\nimporters:`,
    ),
  ],
  [
    'a patched dependency key that starts with the address',
    edit(
      BASE,
      'importers:',
      `patchedDependencies:\n  ${quote(`https://user:${MARKER}@h.example/a.tgz`)}:\n    hash: abc\n    path: patches/a.patch\n\nimporters:`,
    ),
  ],
  ['a resolution tarball', resolution(`{tarball: "${TARBALL_WITH_PASSWORD}"}`)],
  [
    'a resolution git repository',
    resolution(
      `{commit: ${COMMIT}, repo: "https://${MARKER}@h.example/r.git", type: git}`,
    ),
  ],
  [
    'a runtime archive address',
    resolution(
      `{type: variations, variants: [{resolution: {type: binary, archive: tarball, url: "${TARBALL_WITH_PASSWORD}", integrity: ${SHA512}, bin: bin/a}, targets: [{os: linux, cpu: x64}]}]}`,
    ),
  ],
  [
    'a key listed twice',
    edit(
      BASE,
      'snapshots:\n',
      `snapshots:\n\n  ${quote(`a@${TARBALL_WITH_PASSWORD}`)}: {}\n  ${quote(`a@${TARBALL_WITH_PASSWORD}`)}: {}\n`,
    ),
  ],
  [
    'a query string that carries a token, in a key that does not parse',
    snapshotKey(`a@https://h.example/a.tgz?sig=${MARKER}(`),
  ],
];

describe('a refusal never quotes a credential', () => {
  it.each(CASES)('%s', (_label, text) => {
    expect(text).toContain(MARKER);
    const error = refusalOf(text);
    const surfaces = [
      error.message,
      error.where,
      error.stack ?? '',
      String(error),
      JSON.stringify(error),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(LEAK);
    // Still a message a person can act on: it names the host or the place.
    expect(`${error.message} ${error.where}`).toMatch(
      /h\.example|packages|snapshots|importers|catalogs|patchedDependencies/u,
    );
  });

  it('leaves nothing of a credential wherever the cut that shortens a long key falls', () => {
    // The key is quoted up to 120 characters; the user name below puts the start
    // of the password at every offset around that cut, from well inside it to past it.
    for (let user = 70; user <= 110; user += 1) {
      const error = refusalOf(
        packageKey(`a@https://${'u'.repeat(user)}:${MARKER}@h.example/a.tgz`),
      );
      expect(error.message, `user of ${user} characters`).not.toContain(
        'vtok_',
      );
      expect(error.message).toContain('has a version that');
    }
  });

  it('keeps the host and the path, so the message still says which address', () => {
    const error = refusalOf(packageKey(`a@${TARBALL_WITH_PASSWORD}`));
    expect(error.message).toContain('h.example/a.tgz');
    expect(error.message).toContain('carries a password');
  });

  it('keeps the user git, which is not a secret', () => {
    const error = refusalOf(
      packageKey(`a@git+ssh://git@h.example/r.git#${COMMIT.slice(0, 7)}`),
    );
    expect(error.message).toContain('git+ssh://git@h.example/r.git');
  });

  it('is a PnpmLockError with the same reason as before', () => {
    const error = refusalOf(packageKey(`a@${TARBALL_WITH_PASSWORD}`));
    expect(error).toBeInstanceOf(PnpmLockError);
    expect(error.reason).toBe('dep-path');
    expect(error.code).toBe('INVALID_LOCKFILE');
  });
});

describe('a report never quotes a token in a query string', () => {
  const address = `https://h.example/a.tgz?sig=${MARKER}`;
  const lock = parsePnpmLock(importerVersion(address));

  it('reads, because a query string is not refused', () => {
    expect(lock.importers[0]?.dependencies[0]?.ref).toMatchObject({
      kind: 'dep',
      raw: address,
    });
  });

  it('lists the problem without the token', () => {
    const report = validatePnpmLock(lock);
    expect(report.problems.length).toBeGreaterThan(0);
    for (const problem of report.problems) {
      expect(problem.where).not.toContain(LEAK);
      expect(problem.message).not.toContain(LEAK);
    }
    expect(report.problems[0]?.message).toContain('h.example/a.tgz');
  });

  it('raises the decision without the token', () => {
    let raised: unknown;
    try {
      assertConsistentPnpmLock(validatePnpmLock(lock));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(PnpmLockError);
    expect(String(raised)).not.toContain(LEAK);
  });
});
