import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/toml.js';

/**
 * Mutation coverage for host-fetch grants: start from a valid plugin pin and
 * kill every mutant. A surviving mutant would mean a silent widening of
 * fetch or Authorization authority.
 */
describe('host-fetch grant mutation coverage', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const valid = `[plugins.dev.example.acme]
store_digest = "${digest}"
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_TOKEN"]
artifact_origin_extra_header_names = ["X-JFrog-Art-Api"]
artifact_origin_extra_header_envs = ["JFROG_API_KEY"]
`;

  it('accepts the unmutated grant', () => {
    expect(
      parseManifest(valid).plugins?.['dev.example.acme']?.artifactOrigins,
    ).toEqual(['https://artifacts.internal.example']);
  });

  it('kills pin, token, and extra-header mutants', () => {
    const mutants: { name: string; toml: string }[] = [
      {
        name: 'http-pin',
        toml: valid.replace(
          'https://artifacts.internal.example',
          'http://127.0.0.1',
        ),
      },
      {
        name: 'duplicate-origin',
        toml: valid.replace(
          '["https://artifacts.internal.example"]',
          '["https://artifacts.internal.example", "https://artifacts.internal.example"]',
        ),
      },
      {
        name: 'path-on-pin',
        toml: valid.replace(
          'https://artifacts.internal.example',
          'https://artifacts.internal.example/repo',
        ),
      },
      {
        name: 'userinfo-pin',
        toml: valid.replace(
          'https://artifacts.internal.example',
          'https://user:secret@artifacts.internal.example',
        ),
      },
      {
        name: 'token-arity',
        toml: valid.replace('["ACME_TOKEN"]', '["ACME_TOKEN", "OTHER"]'),
      },
      {
        name: 'token-not-env-name',
        toml: valid.replace('ACME_TOKEN', 'acme-token'),
      },
      {
        name: 'cookie-header',
        toml: valid.replace('X-JFrog-Art-Api', 'Cookie'),
      },
      {
        name: 'authorization-header',
        toml: valid.replace('X-JFrog-Art-Api', 'Authorization'),
      },
      {
        name: 'header-arity',
        toml: valid.replace('["JFROG_API_KEY"]', '["JFROG_API_KEY", "OTHER"]'),
      },
      {
        name: 'header-without-envs',
        toml: valid.replace(
          'artifact_origin_extra_header_envs = ["JFROG_API_KEY"]\n',
          '',
        ),
      },
    ];
    const survivors: string[] = [];
    for (const mutant of mutants) {
      try {
        parseManifest(mutant.toml);
        survivors.push(mutant.name);
      } catch (error) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as { code?: string }).code).toBe('INVALID_MANIFEST');
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/user:secret/u);
      }
    }
    expect(survivors).toEqual([]);
  });
});
