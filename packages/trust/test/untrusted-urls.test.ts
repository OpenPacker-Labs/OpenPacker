import { describe, expect, test } from 'vitest';
import {
  extractCycloneDxEvidence,
  verifySlsaProvenance,
} from '../src/index.js';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * A software bill of materials and a provenance statement are documents someone
 * else wrote, and the URLs in them are read through the guard: a host no DNS
 * name could be is refused in a few milliseconds and not the most of a second
 * the URL parser takes on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and the
 * refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
const HOSTILE = `https://${HOST}/src.tgz`;
const FAST_MS = 50;

function refusal(run: () => void): { error: Error | undefined; ms: number } {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = cpuMs();
    try {
      run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, cpuMs() - started);
  }
  return { error, ms };
}

const bom = (url: string) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  components: [
    {
      purl: 'pkg:npm/a@1.0.0',
      externalReferences: [{ type: 'distribution', url }],
    },
  ],
});

const subject = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };
const statement = (uri: string) => ({
  _type: 'https://in-toto.io/Statement/v1' as const,
  subject: [{ name: 'artifact', digest: { sha256: subject.value } }],
  predicateType: 'https://slsa.dev/provenance/v1' as const,
  predicate: {
    buildDefinition: {
      buildType: 'https://example.test/build',
      externalParameters: {},
      internalParameters: {},
      resolvedDependencies: [{ uri, digest: { sha256: 'b'.repeat(64) } }],
    },
    runDetails: { builder: { id: 'https://example.test/builder' } },
  },
});

describe('a CycloneDX document with a URL no DNS name could be', () => {
  test('is refused in under 50 ms without repeating the URL', () => {
    const { error, ms } = refusal(() => extractCycloneDxEvidence(bom(HOSTILE)));
    expect(error).toBeInstanceOf(TypeError);
    expect(error?.message).not.toContain('ß');
    expect(error?.message.length).toBeLessThan(200);
    expect(ms).toBeLessThan(FAST_MS);
  });

  test('still gives the canonical form of an ordinary URL', () => {
    expect(
      extractCycloneDxEvidence(bom('HTTPS://Example.test:443/a b'))
        .externalReferences,
    ).toEqual([{ type: 'distribution', url: 'https://example.test/a%20b' }]);
  });
});

describe('a SLSA statement with a material URL no DNS name could be', () => {
  test('is refused in under 50 ms without repeating the URL', () => {
    const { error, ms } = refusal(() =>
      verifySlsaProvenance(statement(HOSTILE), subject),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error?.message).not.toContain('ß');
    expect(error?.message.length).toBeLessThan(200);
    expect(ms).toBeLessThan(FAST_MS);
  });

  test('still gives the canonical form of an ordinary URL', () => {
    expect(
      verifySlsaProvenance(statement('https://Example.test/src'), subject)
        .materials,
    ).toEqual([{ uri: 'https://example.test/src', sha256: 'b'.repeat(64) }]);
  });
});
