import { CanonicalJsonError } from './errors.js';

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function validString(value: string): string {
  if (LONE_SURROGATE.test(value))
    throw new CanonicalJsonError('Lone Unicode surrogate is not valid I-JSON');
  return value;
}

/** A string token of a JSON text, found before anything is decoded from it. */
export interface StringToken {
  /** Just past the closing quote. */
  readonly end: number;
  /**
   * Whether it is charged as two-byte text: a character past U+00FF, or an
   * escape, which may decode to one.
   */
  readonly wide: boolean;
}

/** Why the text at `start` is not a string token, and where that was found. */
export interface NotAString {
  readonly error: string;
  readonly at: number;
}

/**
 * The string token whose opening quote is at `start`: where it ends and how
 * wide it is, so that what it will cost can be charged before it is decoded.
 */
export function scanString(
  input: string,
  start: number,
): StringToken | NotAString {
  let index = start + 1;
  let escaped = false;
  let wide = false;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (escaped) {
      escaped = false;
      if (code === 0x75) wide = true;
    } else if (code === 0x5c) escaped = true;
    else if (code === 0x22) return { end: index + 1, wide };
    else if (code < 0x20)
      return { error: 'Unescaped control character in string', at: index };
    else if (code > 0xff) wide = true;
    index += 1;
  }
  return { error: 'Unterminated JSON string', at: index };
}
