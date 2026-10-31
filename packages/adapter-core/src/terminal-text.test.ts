import { describe, expect, it } from 'vitest';
import { quote, terminalSafe } from './terminal-text.js';

describe('quote', () => {
  it('escapes every character a terminal acts on rather than shows', () => {
    expect(quote('a\u001b]0;PWN\u0007b')).toBe('"a\\u001b]0;PWN\\u0007b"');
    expect(quote('del\u007f')).toBe('"del\\u007f"');
    expect(quote('\u009b31m')).toBe('"\\u009b31m"');
    expect(quote('a\u061cb\u200ec\u202ed\u2066e')).toBe(
      '"a\\u061cb\\u200ec\\u202ed\\u2066e"',
    );
    expect(quote('plain@1.0.0')).toBe('"plain@1.0.0"');
  });

  it('cuts a long value, saying how long it was', () => {
    expect(quote('x'.repeat(1000))).toBe(
      `"${'x'.repeat(200)}"... (1000 characters)`,
    );
  });
});

describe('terminalSafe', () => {
  it('escapes C0 but line feed and tab, DEL, C1 and the bidirectional and format characters', () => {
    expect(
      terminalSafe(
        'a\u001b]0;PWN\u0007 b\rc\u007f\u009b2J\u061c\u200e\u200f\u202a\u202e\u2066\u2069',
      ),
    ).toBe(
      'a\\u001b]0;PWN\\u0007 b\\u000dc\\u007f\\u009b2J\\u061c\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069',
    );
  });

  it('keeps the layout of a message, and is the same when applied twice', () => {
    const message = 'first line\n\tsecond, "quoted" \\ value é';
    expect(terminalSafe(message)).toBe(message);
    const once = terminalSafe('x\u001by');
    expect(terminalSafe(once)).toBe(once);
  });
});
