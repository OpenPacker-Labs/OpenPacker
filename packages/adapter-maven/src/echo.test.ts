import { describe, expect, it } from 'vitest';
import { MavenCodec, parseGradleLockfile } from './index.js';

/**
 * What a message says of text from a Maven document or lock is one line.
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

describe('text that is not a Maven version, range or coordinate', () => {
  const codec = new MavenCodec();

  it.each([
    [
      'a version',
      /^Invalid Maven version: /u,
      () => codec.parseNativeVersion(`1.0${FORGED}`),
    ],
    [
      'a coordinate',
      /^Invalid Maven coordinate: /u,
      () => codec.parseNativeCoordinate(`g:a${FORGED}`),
    ],
    [
      'a range',
      /^Invalid Maven version range: /u,
      () => codec.parseNativeRange(`[1.0${FORGED}`),
    ],
    [
      'a range of too many parts',
      /^Invalid Maven version range: /u,
      () => codec.parseNativeRange(`(1,2,3)${FORGED}`),
    ],
  ])('is one line: %s', (_, start, run) => {
    const message = messageOf(run);
    expect(message).toMatch(start);
    expect(holdsControl(message)).toBe(false);
  });

  it('reads an ordinary one as it always did', () => {
    expect(messageOf(() => codec.parseNativeRange('[1.0'))).toBe(
      'Invalid Maven version range: [1.0',
    );
  });
});

describe('a Gradle lock with a line that is not one', () => {
  it('is one line', () => {
    const message = messageOf(() =>
      parseGradleLockfile(`not a lock entry ${ESC}[2K${BEL}`),
    );
    expect(message).toMatch(
      /^Invalid gradle\.lockfile line: not a lock entry/u,
    );
    expect(holdsControl(message)).toBe(false);
  });
});
