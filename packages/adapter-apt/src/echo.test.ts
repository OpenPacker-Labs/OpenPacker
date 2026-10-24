import { describe, expect, it } from 'vitest';
import { AptSystemProvider } from './index.js';

/**
 * What a refusal says of the package text it was given is one line. The text
 * comes from a PURL a person or a project file names, and what writes the
 * refusal cannot tell a line opm wrote from a line that text added.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

const apt = new AptSystemProvider(
  async () => ({ stdout: '', stderr: '' }),
  () => 'linux',
  () => false,
);

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

async function refusal(purl: string): Promise<string> {
  try {
    await apt.plan(purl);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${purl} was not refused`);
}

describe('what an apt refusal repeats of a PURL', () => {
  it('makes a package name one line', async () => {
    const message = await refusal(
      `pkg:deb/debian/a${encodeURIComponent(FORGED)}@1`,
    );
    expect(message).toMatch(/^Not a valid Debian package name: a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes a version one line', async () => {
    const message = await refusal(
      `pkg:deb/debian/curl@1${encodeURIComponent(FORGED)}`,
    );
    expect(message).toMatch(/^Not a valid Debian version: 1/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('makes the PURL of another ecosystem one line', async () => {
    const message = await refusal(`pkg:npm/a${FORGED}@1`);
    expect(message).toMatch(/^Not a Debian PURL: pkg:npm\/a/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('cuts a long name and says how long it was', async () => {
    const message = await refusal(`pkg:deb/debian/${'A'.repeat(3000)}@1`);
    expect(message.length).toBeLessThan(400);
    expect(message).toContain('3000');
  });

  it('leaves an ordinary refusal as it was', async () => {
    expect(await refusal('pkg:deb/debian/A!@1')).toBe(
      'Not a valid Debian package name: A!',
    );
  });
});
