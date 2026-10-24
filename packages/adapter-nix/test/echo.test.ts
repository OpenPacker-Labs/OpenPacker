import { describe, expect, it } from 'vitest';
import { installableFromPurl, NixCodec, parseStorePath } from '../src/index.js';

/**
 * What a message says of text from a PURL, a store path or a store entry is
 * one line. A person, a project file or a binary cache wrote it, and what
 * writes the message cannot tell a line opm wrote from a line that text added.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;
const OUT_HASH = 'b3f2q8xr7k1v5m9n0p4s6w2y4z6a8c1d';

const provenance = {
  providerId: 'nix-store',
  endpoint: 'nix-store:local',
  retrievedAt: '2026-10-12T00:00:00Z',
  evaluationTime: '2026-10-12T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
};

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

function messageOf<T>(act: () => T): string {
  try {
    act();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('was not refused');
}

describe('what a nix message repeats', () => {
  it('makes a store path one line', () => {
    const message = messageOf(() => parseStorePath(`/nix/store/a${FORGED}`));
    expect(message).toMatch(/^Not a Nix store path: \/nix\/store\/a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes an installable one line', () => {
    const message = messageOf(() => installableFromPurl(`nixpkgs#a${FORGED}`));
    expect(message).toMatch(/^Not a usable Nix installable: nixpkgs#a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes a PURL that does not parse one line', () => {
    const message = messageOf(() => installableFromPurl(`pkg:${FORGED}`));
    expect(message).toMatch(/^Not a usable Nix PURL: pkg:/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes the PURL of another ecosystem one line', () => {
    const message = messageOf(() =>
      installableFromPurl(`pkg:npm/a${FORGED}@1`),
    );
    expect(message).toMatch(/^Not a nix PURL: pkg:npm\/a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes a native constraint in a loss one line', () => {
    const range = new NixCodec().parseNativeRange(`>=1${FORGED}`);
    const reasons = range.semanticLoss.map((item) => JSON.stringify(item));
    expect(reasons).toHaveLength(1);
    expect(reasons.join('')).not.toContain('\\nopm: internal error');
    expect(JSON.stringify(range.semanticLoss[0])).toMatch(/not an exact/u);
  });

  it('makes a narHash in a loss one line', async () => {
    const { instance } = await new NixCodec().translateMetadata(
      {
        path: `/nix/store/${OUT_HASH}-libgreet-1.0`,
        narHash: `md5:zz${FORGED}`,
      },
      provenance,
    );
    const hashLoss = instance.semanticLoss.find(
      (item) => item.code === 'CONTENT_ADDRESS_UNSUPPORTED',
    );
    const text = JSON.stringify(hashLoss);
    expect(text).toContain('md5:zz');
    expect(text).not.toContain('\\nopm: internal error');
  });

  it('leaves an ordinary refusal as it was', () => {
    expect(messageOf(() => parseStorePath('/tmp/x'))).toBe(
      'Not a Nix store path: /tmp/x',
    );
  });
});
