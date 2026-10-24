import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  GolangCodec,
  splitModulePath,
  type GolangModuleVersionMetadata,
} from './index.js';

/**
 * What a message says of text from a Go module's document is one line.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const metadata = JSON.parse(
  (
    await readFile(
      new URL(
        '../../../fixtures/catalogs/golang/module-metadata.json',
        import.meta.url,
      ),
    )
  ).toString(),
) as GolangModuleVersionMetadata;

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-10-12T00:00:00Z',
  evaluationTime: '2026-10-12T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '6'.repeat(64) },
};

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('a module coordinate that is not one', () => {
  it('is one line', () => {
    const message = messageOf(() =>
      new GolangCodec().parseNativeCoordinate(`/bad${FORGED}`),
    );
    expect(message).toMatch(/^Invalid Go module coordinate: /u);
    expect(holdsControl(message)).toBe(false);
  });

  it('is one line for a path with nothing in it', () => {
    const message = messageOf(() => splitModulePath('//'));
    expect(message).toBe('Empty Go module path: //');
  });
});

describe('a build constraint that is not an OS and architecture', () => {
  it('is recorded in one line', async () => {
    const translated = await new GolangCodec().translateMetadata(
      { ...metadata, buildConstraints: [`linux && !cgo${FORGED}`] },
      provenance,
    );
    const meanings = translated.instance.semanticLoss
      .filter((loss) => loss.code === 'GOLANG_BUILD_CONSTRAINT_NOT_EXACT')
      .map((loss) => loss.originalMeaning ?? '');
    expect(meanings).toHaveLength(1);
    expect(meanings[0]).toMatch(/^Build constraint linux && !cgo/u);
    expect(holdsControl(meanings[0]!)).toBe(false);
  });
});
