import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../src/index.js';

/**
 * A provider's answer names where an artifact is, and the service URL is the
 * person's own setting. Each is read through the guard: a host no DNS name could
 * be is refused in a few milliseconds and not the most of a second the URL
 * parser takes on 65,550 characters of it (`@openpacker/canonical`'s
 * `untrusted-url.test.ts` measures that), and the refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
const FAST_MS = 50;

function io(): CliIo & { out: string; err: string } {
  const result = {
    out: '',
    err: '',
    stdin: Readable.from([]),
    stdout: {
      write(value: string | Uint8Array) {
        result.out += value.toString();
        return true;
      },
    },
    stderr: {
      write(value: string | Uint8Array) {
        result.err += value.toString();
        return true;
      },
    },
  };
  return result;
}

afterEach(() => vi.unstubAllGlobals());

async function materializeFrom(transport: 'https' | 'file', uri: string) {
  let best = Infinity;
  let last = io();
  let exit = -1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        descriptor: {
          descriptorId: 'fixture',
          mediaType: 'application/x-tar',
          artifactType: 'package',
          digest: { algorithm: 'sha256', value: '0'.repeat(64) },
          size: 0,
          nativeRole: 'native-package',
          fileName: 'archive.tar',
          locations: [{ transport, uri, priority: 0, rangeSupported: false }],
          referrers: [],
          externalRefs: [],
        },
      }),
    );
    last = io();
    const started = performance.now();
    exit = await runCli(
      ['materialize', 'pkg:npm/demo@1.0.0', '--install-prefix', '/nonexistent'],
      last,
    );
    best = Math.min(best, performance.now() - started);
  }
  return { exit, output: last, ms: best };
}

describe('the openpacker CLI', () => {
  it.each([
    ['https', `https://${HOST}/archive.tar`],
    ['file', `file://${HOST}/archive.tar`],
  ] as const)(
    'refuses a provider %s location whose host is longer than a name can be',
    async (transport, uri) => {
      const { exit, output, ms } = await materializeFrom(transport, uri);
      expect(exit).toBe(EXIT_CODES.invalidInput);
      expect(output.err).toMatch(/not a URL|longer than/u);
      expect(output.err).not.toContain('ß');
      expect(output.err.length).toBeLessThan(400);
      expect(ms).toBeLessThan(FAST_MS);
    },
  );

  it('refuses an offline service URL whose host is longer than a name can be', async () => {
    let best = Infinity;
    let exit = -1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = io();
      const started = performance.now();
      exit = await runCli(
        [
          'normalize',
          'pkg:npm/demo',
          '--offline',
          '--base-url',
          `http://${HOST}:7337`,
        ],
        output,
      );
      best = Math.min(best, performance.now() - started);
      expect(output.err).not.toContain('ß');
    }
    expect(exit).toBe(EXIT_CODES.usage);
    expect(best).toBeLessThan(FAST_MS);
  });
});
