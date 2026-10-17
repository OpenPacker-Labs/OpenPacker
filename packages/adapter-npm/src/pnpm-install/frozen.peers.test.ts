/**
 * What a frozen read of a pnpm lock says about the peers the places keep to
 * one copy (ADR 0055 §9): nothing when they all are, and how many are not, and
 * which first, when no layout can keep them. The lock is the review's world of
 * a package that depends on an older version of itself and hosts a plugin that
 * peers it.
 */

import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '../pnpm-lock/fixture-support.js';
import { worldOf } from './frozen-support.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const HOST = 'p1@3.0.0(p4@1.0.0(p1@3.0.0))';
const PLUGIN = 'p4@1.0.0(p1@3.0.0)';
const NEEDS_BOTH = 'p2@1.0.0(p1@3.0.0)(p4@1.0.0(p1@3.0.0))';

/** `p1@3` depends on `p1@1`, on `p2@1` and on a plugin `p4` that peers `p1`; `p2@1` peers `p4` and `p1`. */
const KEPT_SPLIT = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  '.': {}
  packages/m2:
    dependencies:
      p1: {specifier: '*', version: '3.0.0(p4@1.0.0(p1@3.0.0))'}
      p2: {specifier: '*', version: '3.0.0'}
      p4: {specifier: '*', version: '1.0.0(p1@3.0.0)'}
packages:
  p1@1.0.0: {resolution: {integrity: ${INTEGRITY}}}
  p1@3.0.0: {resolution: {integrity: ${INTEGRITY}}}
  p2@1.0.0: {resolution: {integrity: ${INTEGRITY}}, peerDependencies: {p1: '*', p4: '*'}}
  p2@3.0.0: {resolution: {integrity: ${INTEGRITY}}}
  p4@1.0.0: {resolution: {integrity: ${INTEGRITY}}, peerDependencies: {p1: '*'}}
snapshots:
  p1@1.0.0: {}
  ${HOST}:
    dependencies:
      p1: 1.0.0
      p2: ${NEEDS_BOTH.replace(/^p2@/u, '')}
      p4: ${PLUGIN.replace(/^p4@/u, '')}
  ${PLUGIN}:
    dependencies:
      p1: ${HOST.replace(/^p1@/u, '')}
  ${NEEDS_BOTH}:
    dependencies:
      p1: ${HOST.replace(/^p1@/u, '')}
      p4: ${PLUGIN.replace(/^p4@/u, '')}
  p2@3.0.0: {}
`;

describe('a lock whose peers no layout can keep to one copy', () => {
  it('is read, every place resolved, and says how many dependencies load their own copy and which first', async () => {
    const lock = await (await worldOf(KEPT_SPLIT)).read();
    expect(lock.refused).toEqual([]);
    expect(lock.packages).toHaveLength(8);
    expect(lock.peers).toEqual({
      splits: 1,
      withoutPeers: false,
      first: { dependency: '"p2@1.0.0"', dependent: '"p1@3.0.0"' },
    });
  });
});

describe('a lock whose peers every layout keeps to one copy', () => {
  it.each(['ai-bdd.pnpm-lock.yaml', 'hobo.cut.pnpm-lock.yaml'] as const)(
    'says nothing (%s)',
    async (name) => {
      const lock = await (await worldOf(fixtureBytes(name))).read();
      expect(lock.refused).toEqual([]);
      expect(lock.peers).toBeUndefined();
    },
  );
});
