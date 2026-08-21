import { describe, expect, it } from 'vitest';
import { runBasicClient } from '../src/index.js';

describe('basic client example', () => {
  it('discovers capability before sending the typed request', async () => {
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      paths.push(url.pathname);
      if (url.pathname === '/v1/capabilities')
        return Response.json({
          meta: {
            protocolVersion: '1.0-draft',
            provider: {
              id: 'fixture',
              implementation: 'fixture',
              version: '1',
            },
          },
          protocolVersions: ['1.0-draft'],
          operations: ['normalize'],
          conformanceLevels: ['PREX-N'],
          purlTypes: ['npm'],
          versSchemes: ['npm'],
          semanticsProfiles: [],
          targetDimensions: [],
          evidenceTypes: [],
          artifactTransports: [],
          contentEncodings: ['identity'],
          eventBindings: [],
          limits: {
            requestBytes: 1048576,
            batchItems: 16,
            universeNodes: 1,
            graphNodes: 1,
            artifactMetadataBytes: 1,
          },
          pagination: { supported: true, maximumPageSize: 100 },
          streaming: { supported: false, bindings: [] },
          authenticationSchemes: [{ type: 'none' }],
          extensionSchemaRefs: [],
        });
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const body = JSON.parse(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        new TextDecoder().decode(init?.body as ArrayBuffer),
      ) as { items: unknown[] };
      return Response.json({
        meta: {
          protocolVersion: '1.0-draft',
          provider: { id: 'fixture', implementation: 'fixture', version: '1' },
        },
        results: body.items,
      });
    };

    const result = await runBasicClient({ fetch });
    expect(paths).toEqual(['/v1/capabilities', '/v1/normalize']);
    expect(result.normalization.rawBytes.byteLength).toBeGreaterThan(0);
  });
});
