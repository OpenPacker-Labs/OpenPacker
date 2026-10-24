import { describe, expect, it } from 'vitest';
import type { PackageInstance } from '@openpacker/contracts';
import { assignEdges } from '../src/closure-edges.js';

/**
 * A package of an ecosystem whose adapter serves a catalog and no codec (a
 * plugin's, or a test's) is selected once: there are no versions to put in
 * order, so no codec is asked for. Only a package selected at several versions
 * needs one to say which is newest.
 */
function instance(nodeId: string, version: string): PackageInstance {
  // SAFETY: a literal with the fields assignEdges reads.
  return {
    nodeId,
    nativeVersion: version,
    identity: {
      canonicalPurl: 'pkg:acme/demo',
      exactPurl: `pkg:acme/demo@${version}`,
      purlType: 'acme',
    },
    requirements: [],
  } as unknown as PackageInstance;
}

describe('assignEdges, for an ecosystem with no codec', () => {
  it('does not ask for one when each package is selected once', () => {
    expect(assignEdges([instance('a', '1.0.0')])).toEqual({
      edges: [],
      unmet: [],
    });
  });

  it('still needs one to order several versions of a package', () => {
    expect(() =>
      assignEdges([instance('a', '1.0.0'), instance('b', '2.0.0')]),
    ).toThrow(/No adapter is registered/iu);
  });
});
