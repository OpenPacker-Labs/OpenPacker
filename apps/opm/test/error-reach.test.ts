import { describe, expect, it } from 'vitest';
import { EXIT_CODES, runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * Every error a command ends with goes through the one writer. A command that
 * returns the promise of another, inside the `try`, hands its rejection to the
 * caller's caller, past the handler: Node then prints the message as it is, with
 * whatever a terminal would act on in it.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const hostile = `x${ESC}]0;pwned${BEL}y`;

/** A control character other than the line feed a report ends its lines with. */
function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

describe('a command that rejects', () => {
  it('reaches the handler when it is an unknown system subcommand', async () => {
    const cap = capture();
    const code = await runOpm(['system', hostile], cap.io, process.cwd());
    expect(code).toBe(EXIT_CODES.usage);
    expect(cap.err).toMatch(
      /^Unknown system subcommand: xy\. Use available \| plan \| install\.\n\n/u,
    );
    expect(holdsControl(cap.err)).toBe(false);
  });

  it('reaches the handler when a host install cannot be planned', async () => {
    const cap = capture();
    const code = await runOpm(
      ['system', 'plan', `pkg:apt/${hostile}`],
      cap.io,
      process.cwd(),
    );
    expect(code).toBe(EXIT_CODES.invalidInput);
    expect(cap.err).toBe(
      'opm: Not a Debian PURL: pkg:apt/xy (expected pkg:deb/...)\n',
    );
  });

  it('reaches the handler when add hands a package to a host installer', async () => {
    const cap = capture();
    const code = await runOpm(
      ['add', `pkg:apt/${hostile}`, '--dry-run'],
      cap.io,
      process.cwd(),
    );
    expect(code).toBe(EXIT_CODES.invalidInput);
    expect(cap.err).toBe(
      'opm: Not a Debian PURL: pkg:apt/xy (expected pkg:deb/...)\n',
    );
  });
});
