/**
 * Anything a terminal, a log or a bidi-aware renderer would act on, as numeric
 * code point ranges written out here. The implementation drops characters by
 * their Unicode general category; this list is not that class, so a category it
 * missed would not also be missing from here by construction.
 */
export const FORBIDDEN: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls: ESC, BEL, newline, tab
  [0x007f, 0x009f], // DEL and the C1 controls: U+009B is CSI, U+009D is OSC
  [0x00ad, 0x00ad], // soft hyphen
  [0x0600, 0x0605], // Arabic number signs
  [0x061c, 0x061c], // Arabic letter mark
  [0x06dd, 0x06dd], // Arabic end of ayah
  [0x070f, 0x070f], // Syriac abbreviation mark
  [0x0890, 0x0891], // Arabic pound and piastre marks above
  [0x08e2, 0x08e2], // Arabic disputed end of ayah
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width characters and the direction marks
  [0x2028, 0x202e], // line and paragraph separators, embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // isolates and the deprecated format characters
  [0xfeff, 0xfeff], // byte order mark
  [0xfff9, 0xfffb], // interlinear annotation
  [0xd800, 0xdfff], // surrogates
  [0x110bd, 0x110bd], // Kaithi number sign
  [0x110cd, 0x110cd], // Kaithi number sign above
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol beam and slur controls
  [0xe0001, 0xe0001], // language tag
  [0xe0020, 0xe007f], // tag characters
];

export function holdsForbidden(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (FORBIDDEN.some(([low, high]) => code >= low && code <= high))
      return true;
  }
  return false;
}
