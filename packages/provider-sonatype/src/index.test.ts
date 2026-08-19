import { expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { SonatypeProvider } from './index.js';

it('rejects plaintext endpoints before resolving credentials', () => {
  expect(
    () =>
      new SonatypeProvider(
        new FixtureHttpTransport(new Map()),
        { resolve: async () => ({ authorization: 'Bearer fixture' }) },
        { now: () => '2026-08-02T00:00:00Z' },
        'http://sonatype.test',
        'secret://sonatype/test',
      ),
  ).toThrow(/must use HTTPS/u);
});

it('uses a secret reference and reports coordinate mismatches without rewriting identity', async () => {
  const requested = 'pkg:nuget/demo@1.0.0';
  const body = new TextEncoder().encode(
    JSON.stringify({
      components: [
        { purl: 'pkg:nuget/demo@1.0.1', policyEvaluation: { action: 'warn' } },
      ],
    }),
  );
  const transport = new FixtureHttpTransport(
    new Map([
      [
        `https://sonatype.test/api/v2/components/details?purl=${encodeURIComponent(requested)}`,
        { status: 200, headers: {}, body },
      ],
    ]),
  );
  let resolved = '';
  const provider = new SonatypeProvider(
    transport,
    {
      resolve: async (reference) => {
        resolved = reference;
        return { authorization: 'Bearer redacted-fixture' };
      },
    },
    { now: () => '2026-08-02T00:00:00Z' },
    'https://sonatype.test',
    'secret://sonatype/test',
  );
  const result = await provider.enrich(requested);
  expect(resolved).toBe('secret://sonatype/test');
  expect(result.subjectPurl).toBe(requested);
  expect(result.warnings[0]?.code).toBe('SONATYPE_COORDINATE_MISMATCH');
  expect(JSON.stringify(result)).not.toContain('redacted-fixture');
});

it('warns when Sonatype returns ambiguous exact matches', async () => {
  const requested = 'pkg:nuget/demo@1.0.0';
  const body = new TextEncoder().encode(
    JSON.stringify({
      components: [
        { purl: requested, componentIdentifier: 'one' },
        { purl: requested, componentIdentifier: 'two' },
      ],
    }),
  );
  const provider = new SonatypeProvider(
    new FixtureHttpTransport(
      new Map([
        [
          `https://sonatype.test/api/v2/components/details?purl=${encodeURIComponent(requested)}`,
          { status: 200, headers: {}, body },
        ],
      ]),
    ),
    { resolve: async () => ({ authorization: 'Bearer fixture' }) },
    { now: () => '2026-08-02T00:00:00Z' },
    'https://sonatype.test',
    'secret://sonatype/test',
  );
  const result = await provider.enrich(requested);
  expect(result.warnings).toEqual([
    expect.objectContaining({ code: 'SONATYPE_COORDINATE_AMBIGUOUS' }),
  ]);
});
