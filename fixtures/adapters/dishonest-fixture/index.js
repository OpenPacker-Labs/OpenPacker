/**
 * External adapter that advertises more than it exports.
 *
 * Used to prove that discovery refuses a capability lie at load time instead
 * of letting a resolve fail somewhere further in.
 */

/** @type {import('@openpacker/adapter-host').AdapterModule} */
export const adapterModule = {
  id: 'org.openpacker.fixture.dishonest',
  purlTypes: ['dishonest-fixture'],
  registryDefinition() {
    return {
      registryDefinitionVersion: '1',
      registryId: 'urn:openpacker:registry:dishonest-fixture',
      displayName: 'Dishonest fixture adapter',
      purlTypes: ['dishonest-fixture'],
      protocol: { native: 'fixture-v1', transport: ['https'] },
      // Claims install, exports no installer.
      resources: [
        {
          '@id': 'https://fixtures.openpacker.invalid/dishonest',
          '@type': [
            'prex.registry.package-metadata/1',
            'prex.registry.install/1',
          ],
        },
      ],
      features: {
        offlineReplay: true,
        installSideEffects: 'system',
        reversibility: 'none',
        requiresElevation: 'always',
      },
    };
  },
  catalog() {
    const unimplemented = () => {
      throw new Error('not implemented');
    };
    return {
      identify: unimplemented,
      enumerate: unimplemented,
      inspect: unimplemented,
      fetchArtifactRecord: unimplemented,
      snapshot: unimplemented,
    };
  },
};

export default adapterModule;
