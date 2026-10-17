/**
 * A value from the lock, `pnpm-workspace.yaml` or a `package.json`, as a
 * message may show it.
 *
 * Those files are input from the repository and a message goes to a terminal,
 * so every such value reaches one through here: JSON-quoted (which escapes the
 * C0 controls, ESC and BEL among them), with the characters `JSON.stringify`
 * leaves alone and a terminal or a reader may still act on escaped as well (the
 * C1 controls, CSI at U+009B among them; the bidirectional overrides and
 * isolates; zero-width and line separators), and cut to a length a line can
 * hold (a 200 KB specifier was echoed whole).
 */

const LONGEST = 200;

/** Characters JSON.stringify writes as they are, which a terminal may not show as they are. */
const HIDDEN =
  /[\u0080-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

const escaped = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** `text` quoted, escaped and cut, ready to put in a message. */
export function quote(text: string): string {
  const shown = JSON.stringify(text.slice(0, LONGEST)).replace(HIDDEN, escaped);
  return text.length > LONGEST
    ? `${shown}... (${text.length} characters)`
    : shown;
}
