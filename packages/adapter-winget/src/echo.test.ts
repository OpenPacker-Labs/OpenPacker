import { describe, expect, it } from 'vitest';
import { WingetSystemProvider } from './index.js';

/**
 * What a refusal says of the package text it was given is one line. The text
 * comes from a PURL a person or a project file names, and what writes the
 * refusal cannot tell a line opm wrote from a line that text added.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

const winget = new WingetSystemProvider(
  async () => ({ stdout: '', stderr: '' }),
  () => 'win32',
  async () => 'winget',
);

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

async function refusal(purl: string): Promise<string> {
  try {
    await winget.plan(purl);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${purl} was not refused`);
}

describe('what a winget refusal repeats of a PURL', () => {
  it('makes an identifier one line', async () => {
    const message = await refusal(
      `pkg:winget/Pub/a${encodeURIComponent(FORGED)}@1`,
    );
    expect(message).toMatch(/^Not a valid winget package identifier: Pub\.a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes a version one line', async () => {
    const message = await refusal(
      `pkg:winget/Pub/a@1${encodeURIComponent(FORGED)}`,
    );
    expect(message).toMatch(/^Not a valid winget version: 1/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes the PURL of another ecosystem one line', async () => {
    const message = await refusal(`pkg:npm/a${FORGED}@1`);
    expect(message).toMatch(/^Not a winget PURL: pkg:npm\/a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes an identifier without a publisher one line', () => {
    let message = '';
    try {
      winget.canonicalPurl(`a${FORGED}`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^A winget identifier is Publisher\.Package: a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('leaves an ordinary refusal as it was', async () => {
    expect(await refusal('pkg:winget/Pub/a!@1')).toBe(
      'Not a valid winget package identifier: Pub.a!',
    );
  });
});
