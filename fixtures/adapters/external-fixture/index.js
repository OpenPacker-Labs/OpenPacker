/**
 * Minimal external adapter used to prove discovery without core edits.
 * Loaded only via adapter-host createRegistryFromDiscovery({ imports }).
 */

/** @type {import('@openpacker/adapter-host').AdapterModule} */
export const adapterModule = {
  id: 'org.openpacker.fixture.external',
  purlTypes: ['external-fixture'],
  registryDefinition() {
    return {
      registryDefinitionVersion: '1',
      registryId: 'urn:openpacker:registry:external-fixture',
      displayName: 'External fixture adapter',
      purlTypes: ['external-fixture'],
      protocol: { native: 'fixture-v1', transport: ['https'] },
      resources: [
        {
          '@id': 'https://fixtures.openpacker.invalid/external',
          '@type': [
            'prex.registry.package-metadata/1',
            'prex.registry.enumerate-versions/1',
          ],
        },
      ],
      features: {
        offlineReplay: true,
        installSideEffects: 'none',
        reversibility: 'none',
        requiresElevation: 'never',
      },
    };
  },
  codec() {
    return {
      purlType: 'external-fixture',
      canonicalizePurl: (value) => value,
      parseNativeCoordinate: (value) => ({
        ecosystem: 'external-fixture',
        name: value,
        original: value,
      }),
      parseNativeVersion: (value) => ({
        original: value,
        normalized: value,
        release: [0],
        prerelease: [],
        build: [],
      }),
      compareNativeVersions: (left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      parseNativeRange: (value) => ({
        scheme: 'external-fixture',
        original: value,
        normalized: value,
        ast: { type: 'any' },
        reversible: true,
        semanticLoss: [],
      }),
      toVers: (value) => ({
        scheme: 'vers',
        value: `vers:external-fixture/${value}`,
      }),
      satisfies: () => true,
      translateMetadata: async () => {
        throw new Error('not implemented');
      },
      translateLockResult: () => {
        throw new Error('not implemented');
      },
    };
  },
};

export default adapterModule;
