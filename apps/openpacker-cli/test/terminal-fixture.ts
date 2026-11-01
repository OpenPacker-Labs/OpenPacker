/**
 * The characters in `text` a terminal or a reader acts on rather than shows:
 * the C0 controls but line feed and tab, DEL, the C1 controls, the
 * bidirectional marks, overrides and isolates, and the zero-width and line
 * separators. What reaches a terminal from opm must hold none.
 */
export function unsafeIn(text: string): string[] {
  return [...text].filter((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 0x20 && code !== 0x0a && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069)
    );
  });
}
