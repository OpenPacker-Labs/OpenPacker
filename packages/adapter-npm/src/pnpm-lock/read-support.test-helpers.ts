/** Small locks for the tests of the readers, and the edits that make them wrong. */

export const SHA512 = `sha512-${Buffer.alloc(64, 0x61).toString('base64')}`;

/** One importer, one dependency, one package, one snapshot: the smallest lock with every section. */
export const BASE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  a@1.0.0:
    resolution: {integrity: ${SHA512}}

snapshots:

  a@1.0.0: {}
`;

/** `text` with the one occurrence of `from` replaced; a typo in a test fails here, not by passing. */
export function edit(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first === -1 || text.indexOf(from, first + 1) !== -1)
    throw new Error(`expected exactly one ${JSON.stringify(from)} in the lock`);
  return text.replace(from, () => to);
}

/** `BASE` with one line of `section` replaced by the lines `to`. */
export function withSection(section: string, to: string): string {
  return `${BASE}\n${section}:\n${to}\n`;
}

import { PnpmLockError, type PnpmLockReason } from './errors.js';
import type { PnpmLockLimits } from './limits.js';
import { parsePnpmLock } from './parse.js';

export type Case = readonly [
  label: string,
  text: string,
  reason: PnpmLockReason,
  fragment: string,
];

export const sectionKey = (key: string, value: string) =>
  edit(
    BASE,
    "lockfileVersion: '9.0'",
    `lockfileVersion: '9.0'\n${key}: ${value}`,
  );
export const pkg = (resolution: string) =>
  edit(BASE, `{integrity: ${SHA512}}`, resolution);
export const pkgField = (line: string) =>
  edit(
    BASE,
    `    resolution: {integrity: ${SHA512}}`,
    `    resolution: {integrity: ${SHA512}}\n    ${line}`,
  );
export const snapField = (lines: string) =>
  edit(BASE, '  a@1.0.0: {}', `  a@1.0.0:\n${lines}`);
export const importerEntry = (lines: string) =>
  edit(
    BASE,
    `      a:\n        specifier: ^1.0.0\n        version: 1.0.0`,
    lines,
  );
export const importerId = (id: string) => edit(BASE, '  .:\n', `  ${id}:\n`);

/** Read `text` and return the refusal it raises; a lock that reads is a failed test. */
export function refusalOf(
  text: string,
  limits?: Partial<PnpmLockLimits>,
): PnpmLockError {
  try {
    parsePnpmLock(text, limits);
  } catch (error) {
    if (error instanceof PnpmLockError) return error;
    throw error;
  }
  throw new Error('expected the lock to be refused');
}
