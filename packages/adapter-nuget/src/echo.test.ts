import { describe, expect, it } from 'vitest';
import {
  NugetCodec,
  parseNugetServiceIndex,
  parseNugetVersion,
} from './index.js';

/**
 * What a message says of text from a NuGet document is one line.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

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

describe('text that is not a NuGet version, range or coordinate', () => {
  const codec = new NugetCodec();

  it.each([
    ['a version', () => parseNugetVersion(`1.0.0${FORGED}`)],
    ['a coordinate', () => codec.parseNativeCoordinate(`bad id${FORGED}`)],
    ['a floating range', () => codec.parseNativeRange(`1.a.*${FORGED}`)],
    ['a version in a range', () => codec.parseNativeRange(`[1.0${FORGED}]`)],
  ])('is one line: %s', (_, run) => {
    const message = messageOf(run);
    expect(message).toMatch(/^Invalid NuGet /u);
    expect(holdsControl(message)).toBe(false);
  });

  it('reads an ordinary one as it always did', () => {
    expect(messageOf(() => parseNugetVersion('1.0.x'))).toBe(
      'Invalid NuGet version: 1.0.x',
    );
  });
});

describe('a service index that is not JSON', () => {
  it('is one line, whatever the parser quotes of it', () => {
    const body = `{"version":"3.0.0","resources":[${FORGED}`;
    const message = messageOf(() =>
      parseNugetServiceIndex(new TextEncoder().encode(body)),
    );
    expect(message).toMatch(/^NuGet service index is not valid JSON: /u);
    expect(holdsControl(message)).toBe(false);
  });
});
