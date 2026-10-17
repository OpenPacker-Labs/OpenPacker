import { describe, expect, it } from 'vitest';
import { quote } from './terminal-text.js';

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
