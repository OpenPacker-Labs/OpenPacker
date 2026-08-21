import { describe, expect, it } from 'vitest';
import { parseManifest, serializeManifest } from '../src/toml.js';

/**
 * Characterization snapshot of the plugin pin TOML contract. A later change
 * to serialize/parse of artifact_origins or extra-header arrays is a
 * reviewable snapshot diff (`vitest run -u`), not silent drift.
 */
describe('plugin pin TOML characterization', () => {
  it('pins serialize/parse of artifact origins and extra-header grants', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const text = serializeManifest({
      project: { name: 'demo', ecosystems: ['acme'] },
      packages: {},
      plugins: {
        'dev.example.acme-adapter': {
          storeDigest: digest,
          artifactOrigins: ['https://artifacts.internal.example'],
          artifactOriginTokenEnvs: ['ACME_ARTIFACTS_TOKEN'],
          artifactOriginExtraHeaderNames: ['X-JFrog-Art-Api'],
          artifactOriginExtraHeaderEnvs: ['JFROG_API_KEY'],
        },
      },
      options: { offline: false, layout: 'opm' },
    });
    const pluginSection = text
      .split('[plugins.dev.example.acme-adapter]')[1]
      ?.split('\n[')[0]
      ?.trim();
    await expect(`${pluginSection}\n`).toMatchFileSnapshot(
      '__snapshots__/plugin-pin-toml.snap',
    );
    expect(parseManifest(text).plugins?.['dev.example.acme-adapter']).toEqual({
      storeDigest: digest,
      artifactOrigins: ['https://artifacts.internal.example'],
      artifactOriginTokenEnvs: ['ACME_ARTIFACTS_TOKEN'],
      artifactOriginExtraHeaderNames: ['X-JFrog-Art-Api'],
      artifactOriginExtraHeaderEnvs: ['JFROG_API_KEY'],
    });
  });
});
