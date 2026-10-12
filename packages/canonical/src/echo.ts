/**
 * Text from a document that is being refused, made fit for a message.
 *
 * A parser that says what it refused ("Duplicate object member: <key>") hands a
 * stranger's bytes to whoever reads the message: a terminal, a log, a policy
 * report. A key may be megabytes long, and may carry an escape sequence that
 * retitles the window, moves the cursor or rewrites the line above it. This
 * keeps the first `limit` characters that can be shown and drops the rest, so
 * the message is short and holds no control character, however hostile the
 * document is.
 *
 * Dropped, not escaped: terminal escape sequences (CSI, OSC, DCS and the other
 * escape forms) whole, then every remaining control character (C0, DEL, C1),
 * every format character (zero-width characters and the bidirectional
 * overrides that make text read other than it is written) and the line and
 * paragraph separators. What is left is plain, so it is safe wherever the
 * message goes. `plainLine` is the same without the cut, for a writer that shows
 * a whole message on a line of its own.
 */

/** How many characters of the text a message may carry. */
export const ECHO_LIMIT = 64;

/** How much of the text is examined at all. */
const SCAN_LIMIT = 4096;

const ESCAPE = 0x1b;
const BELL = 0x07;
const BACKSLASH = 0x5c;
/** OSC, DCS, SOS, PM and APC: strings that end at BEL or at ESC \. */
const STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

const UNSHOWN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** The index after the escape sequence that starts at `at` (an ESC). */
function endOfEscape(text: string, at: number): number {
  const introducer = text.charCodeAt(at + 1);
  let end = at + 1;
  if (introducer === 0x5b) {
    // CSI: parameters and intermediates, then one final byte.
    end += 1;
    while (end < text.length && isBetween(text.charCodeAt(end), 0x20, 0x3f))
      end += 1;
    if (end < text.length && isBetween(text.charCodeAt(end), 0x40, 0x7e))
      end += 1;
    return end;
  }
  if (STRING_INTRODUCERS.has(introducer)) {
    end += 1;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === BELL) return end + 1;
      if (code === ESCAPE) {
        // ST is ESC \; any other ESC begins a sequence of its own.
        return text.charCodeAt(end + 1) === BACKSLASH ? end + 2 : end;
      }
      end += 1;
    }
    return end;
  }
  // Any other escape form: intermediates, then one final byte.
  while (end < text.length && isBetween(text.charCodeAt(end), 0x20, 0x2f))
    end += 1;
  if (end < text.length && isBetween(text.charCodeAt(end), 0x30, 0x7e))
    end += 1;
  return end;
}

function isBetween(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/** Layout whitespace, which `plainLine` turns into one space. */
const LAYOUT = /[\t\n\v\f\r\u0085\u2028\u2029]/u;

interface Plain {
  /** What can be shown of the text read. */
  shown: string;
  /** How far into the text the reading went. */
  end: number;
}

/**
 * The one reading of a text that every caller shares: escape sequences whole,
 * then every character in UNSHOWN, up to `limit` characters shown and
 * `scanLimit` characters read. With `layout`, a run of layout whitespace is one
 * space between two shown characters and nothing at either end.
 */
function read(
  text: string,
  limit: number,
  scanLimit: number,
  layout: boolean,
): Plain {
  // Nothing past scanLimit is read, an escape sequence's tail included.
  const head = text.length > scanLimit ? text.slice(0, scanLimit) : text;
  let shown = '';
  // The last character appended, kept apart: asking `shown` flattens a string
  // that is still being built, once per character, and a text of tens of
  // thousands of line breaks took seconds.
  let last = '';
  let count = 0;
  let index = 0;
  let spaceDue = false;
  while (index < head.length && count < limit) {
    if (head.charCodeAt(index) === ESCAPE) {
      index = Math.max(endOfEscape(head, index), index + 1);
      continue;
    }
    const character = String.fromCodePoint(head.codePointAt(index) ?? 0xfffd);
    index += character.length;
    if (layout && LAYOUT.test(character)) {
      spaceDue = true;
      continue;
    }
    if (UNSHOWN.test(character)) continue;
    if (spaceDue && last !== '' && last !== ' ' && character !== ' ') {
      shown += ' ';
      count += 1;
    }
    spaceDue = false;
    shown += character;
    last = character;
    count += 1;
  }
  return { shown, end: index };
}

/**
 * `text` as a short, plain string. When anything was cut, or when nothing was
 * left to show of a text that was not empty, the result ends in the length of
 * the original, so a reader can tell a long key from a short one, and a key of
 * control characters from no key at all.
 */
export function safeEcho(text: string, limit = ECHO_LIMIT): string {
  const { shown, end } = read(text, limit, SCAN_LIMIT, false);
  if (end < text.length || (shown === '' && text !== ''))
    return `${shown}… (${text.length} character${text.length === 1 ? '' : 's'})`;
  return shown;
}

/**
 * `text` on one line and fit for a terminal, with nothing cut: the same
 * characters removed as `safeEcho` removes, each run of line breaks and tabs
 * one space, none at either end. For a writer that must show a whole message
 * and add its own line breaks, so that the message cannot add one.
 */
export function plainLine(text: string): string {
  return read(text, Infinity, Infinity, true).shown;
}
