import { describe, expect, it } from 'vitest';
import { validateArchivePath } from './index.js';

/**
 * A name from an archive is a registry's to choose. What an error says of it is
 * one line, so the registry cannot add a line to what opm writes.
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

describe('an archive entry that is refused', () => {
  it.each([
    ['one that climbs out', 'PATH_TRAVERSAL', `../x${FORGED}`],
    ['an absolute one', 'ABSOLUTE_PATH', `/abs${FORGED}`],
  ])('is named in one line: %s', (_, code, path) => {
    const message = messageOf(() => validateArchivePath(path));
    expect(message).toMatch(
      new RegExp(`^Unsafe archive rejected \\(${code}\\): `, 'u'),
    );
    expect(holdsControl(message)).toBe(false);
  });

  it('is cut when the name is long, and says how long it was', () => {
    const message = messageOf(() =>
      validateArchivePath(`../${'x'.repeat(1000)}`),
    );
    expect(message).toContain('… (1003 characters)');
    expect(message.length).toBeLessThan(400);
  });

  it('is named as it always was when it is ordinary', () => {
    expect(messageOf(() => validateArchivePath('../etc/passwd'))).toBe(
      'Unsafe archive rejected (PATH_TRAVERSAL): ../etc/passwd',
    );
  });
});
