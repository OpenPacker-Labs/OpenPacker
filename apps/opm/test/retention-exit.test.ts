import { describe, expect, it } from 'vitest';
import { ProviderError, type CatalogProvider } from '@openpacker/adapter-core';
import { EXIT_CODES } from '../src/opm.js';
import { moduleOf } from './hostile-adapter.js';
import { runWith } from './plain-fixture.js';

/**
 * What a script is told when a resolve's registry is the problem. A registry
 * that changed a document while the resolve was reading it is the registry's
 * (8), like any other registry that cannot be used for now, and the message
 * says which package and what to do.
 */

describe('a registry that changed a document during the resolve', () => {
  it('exits as a registry that cannot be used, naming the package', async () => {
    const message =
      'The registry changed the packument of demo during the resolve; run it again';
    // SAFETY: only the operations the command calls before it fails are given.
    const catalog = {
      providerId: 'dev.test.hostile',
      capabilities: {
        operations: ['identify', 'enumerate', 'inspect', 'artifact'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async identify() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async enumerate() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async inspect() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async fetchArtifactRecord() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async snapshot() {
        throw new ProviderError('STALE_METADATA', message);
      },
    } as unknown as CatalogProvider;
    const ran = await runWith({}, ['resolve', 'pkg:acme/demo'], {
      adapters: [moduleOf({ catalog })],
    });
    expect(ran.code, ran.err).toBe(EXIT_CODES.unavailable);
    expect(ran.err).toBe(`opm: ${message}\n`);
  });
});
