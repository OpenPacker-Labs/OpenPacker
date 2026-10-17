/**
 * `pnpm-lock.yaml` text to the model, or a refusal.
 *
 * This is the whole of reading one lock: bytes to text, text to a plain tree
 * (`yaml-tree.ts`), the tree to the model, every part checked as it is read.
 * What a part means for another part (does this dependency resolve, do these
 * two sections agree) is `validate.ts`.
 */

import { PnpmLockError, shown } from './errors.js';
import {
  DEFAULT_PNPM_LOCK_LIMITS,
  resolvePnpmLockLimits,
  type PnpmLockLimits,
} from './limits.js';
import { readImporters } from './read-importers.js';
import { readPackages } from './read-packages.js';
import {
  readCatalogs,
  readChecksum,
  readOverrides,
  readPatchedDependencies,
  readSettings,
  readTime,
} from './read-root.js';
import { readSnapshots } from './read-snapshots.js';
import {
  asMap,
  asStringList,
  rejectUnknown,
  type ReadContext,
} from './read-support.js';
import type { PnpmLock } from './types.js';
import { readYamlTree, type YamlValue } from './yaml-tree.js';

const ROOT_KEYS = [
  'lockfileVersion',
  'settings',
  'catalogs',
  'overrides',
  'packageExtensionsChecksum',
  'pnpmfileChecksum',
  'ignoredOptionalDependencies',
  'patchedDependencies',
  'time',
  'importers',
  'packages',
  'snapshots',
] as const;

/** The only format read: pnpm 9 and 10 write it. */
export const PNPM_LOCKFILE_VERSION = '9.0';

function checkVersion(root: ReadonlyMap<string, YamlValue>): void {
  const version = root.get('lockfileVersion');
  if (version === undefined)
    throw new PnpmLockError(
      'version',
      "has no lockfileVersion; this reads lockfileVersion '9.0' (pnpm 9 and 10)",
    );
  if (version !== PNPM_LOCKFILE_VERSION)
    throw new PnpmLockError(
      'version',
      `has lockfileVersion ${shown(version)}, and this reads only '9.0' (pnpm 9 and 10); run pnpm install with pnpm 9 or later to rewrite it`,
    );
}

/** Build the model from the plain tree of a lock. */
export function readPnpmLockTree(
  tree: YamlValue,
  limits: PnpmLockLimits,
): PnpmLock {
  const ctx: ReadContext = { limits };
  const root = asMap(tree, 'the top level');
  rejectUnknown(root, ROOT_KEYS, '');
  checkVersion(root);
  const extensions = readChecksum(
    root.get('packageExtensionsChecksum'),
    'packageExtensionsChecksum',
  );
  const pnpmfile = readChecksum(
    root.get('pnpmfileChecksum'),
    'pnpmfileChecksum',
  );
  const ignored = root.get('ignoredOptionalDependencies');
  return {
    lockfileVersion: PNPM_LOCKFILE_VERSION,
    settings: readSettings(root.get('settings')),
    overrides: readOverrides(root.get('overrides'), ctx),
    catalogs: readCatalogs(root.get('catalogs'), ctx),
    patchedDependencies: readPatchedDependencies(
      root.get('patchedDependencies'),
      ctx,
    ),
    ...(extensions !== undefined && { packageExtensionsChecksum: extensions }),
    ...(pnpmfile !== undefined && { pnpmfileChecksum: pnpmfile }),
    ignoredOptionalDependencies:
      ignored === undefined
        ? []
        : asStringList(ignored, 'ignoredOptionalDependencies', ctx),
    time: readTime(root.get('time'), ctx),
    importers: readImporters(root.get('importers'), ctx),
    packages: readPackages(root.get('packages'), ctx),
    snapshots: readSnapshots(root.get('snapshots'), ctx),
  };
}

/** The text of a `pnpm-lock.yaml`, strictly decoded when given as bytes. */
function decode(input: string | Uint8Array): string {
  if (typeof input === 'string') return input;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      input,
    );
  } catch {
    throw new PnpmLockError('encoding', 'is not valid UTF-8');
  }
}

/**
 * Read a `pnpm-lock.yaml` (lockfileVersion '9.0).
 *
 * Throws `PnpmLockError` (code `INVALID_LOCKFILE`) for text that is not the
 * YAML pnpm writes, a section that is not what pnpm writes, a key or value that
 * does not parse, or any bound in `limits` exceeded. Nothing is fetched and
 * nothing outside the text is consulted.
 */
export function parsePnpmLock(
  input: string | Uint8Array,
  limits: Partial<PnpmLockLimits> = DEFAULT_PNPM_LOCK_LIMITS,
): PnpmLock {
  const resolved = resolvePnpmLockLimits(limits);
  if (typeof input !== 'string' && input.byteLength > resolved.maxBytes)
    throw new PnpmLockError(
      'too-large',
      `is ${input.byteLength} bytes, more than the limit of ${resolved.maxBytes} (maxBytes)`,
    );
  return readPnpmLockTree(readYamlTree(decode(input), resolved), resolved);
}
