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
 */

const LONGEST = 200;

/** Characters JSON.stringify writes as they are, which a terminal may not show as they are. */
const HIDDEN =
  /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

const escaped = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** `text` quoted, escaped and cut, ready to put in a message. */
export function quote(text: string): string {
  const shown = JSON.stringify(text.slice(0, LONGEST)).replace(HIDDEN, escaped);
  return text.length > LONGEST
    ? `${shown}... (${text.length} characters)`
    : shown;
}
