/**
 * Text from a repository or an archive, as a message may show it.
 *
 * A lock, a `pnpm-workspace.yaml`, a `package.json` and an archive's own
 * manifest are input a stranger may have written, and a message goes to a
 * terminal, so a value from one reaches a message through `quote`: JSON-quoted
 * (which escapes the C0 controls, ESC and BEL among them), with the characters
 * `JSON.stringify` leaves alone and a terminal or a reader may still act on
 * escaped as well (DEL; the C1 controls, CSI at U+009B among them; the
 * bidirectional marks, overrides and isolates; zero-width and line separators),
 * and cut to a length a line can hold (a 200 KB specifier was echoed whole).
 * Whatever is printed at all, a message that quoted nothing included, goes
 * through `terminalSafe` last, which escapes the same characters and every C0
 * control but the line feed and tab a message is laid out with.
 */

const LONGEST = 200;

/**
 * What a terminal or a reader may act on rather than show: the C0 controls but
 * line feed and tab (ESC, BEL and CR among them), DEL, the C1 controls (CSI at
 * U+009B among them), the bidirectional marks, overrides and isolates, and the
 * zero-width and line separators. JSON.stringify escapes only the C0 ones.
 */
const unsafe = (code: number): boolean =>
  (code < 0x20 && code !== 0x0a && code !== 0x09) ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0xad ||
  code === 0x61c ||
  code === 0x180e ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff;

const escaped = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** `text` quoted, escaped and cut, ready to put in a message. */
export function quote(text: string): string {
  const shown = terminalSafe(JSON.stringify(text.slice(0, LONGEST)));
  return text.length > LONGEST
    ? `${shown}... (${text.length} characters)`
    : shown;
}

/**
 * `text` with every character a terminal may act on written as its `\uXXXX`
 * escape, and nothing else changed: the last step before a message is printed.
 */
export function terminalSafe(text: string): string {
  let safe = '';
  for (const character of text)
    safe += unsafe(character.codePointAt(0)!) ? escaped(character) : character;
  return safe;
}
