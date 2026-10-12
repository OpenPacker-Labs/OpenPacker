import { describe, expect, it } from 'vitest';
import * as adapter from '../index.js';
import * as pnpmLock from './index.js';

describe('the package entry point', () => {
  it('exports everything the pnpm lock reader does', () => {
    for (const name of Object.keys(pnpmLock))
      expect(adapter, name).toHaveProperty(
        name,
        pnpmLock[name as keyof typeof pnpmLock],
      );
    expect(Object.keys(pnpmLock).sort()).toEqual([
      'DEFAULT_PNPM_LOCK_LIMITS',
      'MAXIMUM_REPORTED_PROBLEMS',
      'PNPM_LOCKFILE_VERSION',
      'PnpmLockError',
      'assertConsistentPnpmLock',
      'catalogOfSpecifier',
      'exoticSourcesOf',
      'formatDepPath',
      'isWorkspaceSpecifier',
      'packageKeyOf',
      'parseDepPath',
      'parsePnpmLock',
      'parseRef',
      'patchedPackageName',
      'readPnpmLock',
      'readPnpmLockTree',
      'resolvePnpmLockLimits',
      'summarizePnpmLock',
      'validatePnpmLock',
    ]);
  });
});
