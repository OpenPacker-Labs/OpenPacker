/**
 * A bound on the host of an address, checked before a URL parser reads it.
 *
 * Node's `new URL` takes time that grows with the square of the length of the
 * host of a special-scheme address when the host is made of many non-ASCII
 * labels, raw or percent-escaped: `'http://' + 'ß.é.'` repeated to 524,295
 * characters takes 37 seconds, and 65,536 characters take 1.2 seconds. No such
 * host can be a DNS name, which is at most 253 characters as text, so a caller
 * that reads an address out of text a registry or a lock chose asks first, and
 * does not hand the parser an address whose host is longer.
 *
 * Which text that is, is what the URL Standard's basic URL parser hands to its
 * host parser, found without running the parser. `test/whatwg-host.ts` runs the
 * standard's states over code points and `test/url-host.spec.test.ts` holds the
 * two readings to each other.
 */

/** The longest host name there is, in characters: 255 octets on the wire. */
export const LONGEST_HOST_LENGTH = 253;

/**
 * The special schemes other than `file`, whose hosts the parser runs through
 * IDNA. Every other scheme has an opaque host, which it reads in linear time
 * (2 to 25 ms for a mebibyte), so its address is never withheld.
 */
const SPECIAL_SCHEMES = new Set(['ftp', 'http', 'https', 'ws', 'wss']);

/** What the parser removes from its input wherever it is. */
const DROPPED = /[\t\n\r]/gu;
/** A scheme and its colon, at the position `lastIndex` names. */
const SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:/uy;
/** What ends an authority. A special scheme reads `\` as `/`. */
const AUTHORITY_END = /[/\\?#]/gu;
/** What ends the path of a URL that has an opaque one. */
const OPAQUE_PATH_END = /[?#]/gu;

const SPACE = 0x20;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const OPENING_BRACKET = 0x5b;
const CLOSING_BRACKET = 0x5d;
const VERTICAL_BAR = 0x7c;

/**
 * The input the parser works on: without the C0 controls and spaces at either
 * end, and without a tab or newline anywhere.
 */
function parserInput(address: string): string {
  let from = 0;
  let to = address.length;
  while (from < to && address.charCodeAt(from) <= SPACE) from += 1;
  while (to > from && address.charCodeAt(to - 1) <= SPACE) to -= 1;
  const stripped =
    from === 0 && to === address.length ? address : address.slice(from, to);
  return stripped.replace(DROPPED, '');
}

function isSeparator(unit: number): boolean {
  return unit === SLASH || unit === BACKSLASH;
}

/** Where the authority that begins at `from` ends: at a delimiter, or at `limit`. */
function authorityEnd(text: string, from: number, limit: number): number {
  AUTHORITY_END.lastIndex = from;
  const found = AUTHORITY_END.exec(text)?.index ?? limit;
  return found < limit ? found : limit;
}

/** A letter and a `:` or `|`: what the file host state takes for a drive, not a host. */
function isWindowsDriveLetter(text: string, from: number, to: number): boolean {
  if (to - from !== 2) return false;
  const letter = text.charCodeAt(from) | 0x20;
  const mark = text.charCodeAt(from + 1);
  return (
    letter >= 0x61 &&
    letter <= 0x7a &&
    (mark === COLON || mark === VERTICAL_BAR)
  );
}

/**
 * The file host state: after `file:` come two slashes or backslashes, and the
 * host is everything up to the next `/`, `\`, `?` or `#`. There is no userinfo
 * and no port, so an `@` or a `:` is part of it.
 */
function fileHostLength(
  text: string,
  afterColon: number,
  limit: number,
): number {
  if (
    afterColon + 2 > limit ||
    !isSeparator(text.charCodeAt(afterColon)) ||
    !isSeparator(text.charCodeAt(afterColon + 1))
  )
    return 0;
  const start = afterColon + 2;
  const end = authorityEnd(text, start, limit);
  return isWindowsDriveLetter(text, start, end) ? 0 : end - start;
}

/**
 * The authority and host states of the other special schemes. Slashes and
 * backslashes are skipped, however many there are or none. The authority runs
 * to the next `/`, `\`, `?` or `#`, and its userinfo ends at the last `@`. The
 * host runs to the first `:` that is not inside brackets (a `[` switches the
 * port colon off until a `]`, wherever it stands in the host).
 *
 * Where Node's parser differs from the Standard, the cost is Node's. When the
 * host ends inside an open bracket and does not begin with `[` (`x[h.test/`),
 * the Standard ends it at the authority's end, and Node's parser reads on past
 * `/`, `?` and `\` to the next `#` or the end of the input, and takes the
 * square of that length on non-ASCII labels (`http://x[h.test/` followed by
 * 128 KiB of `ß.é.`: 1.1 s; 512 KiB: 106 s). So that is the length it returns.
 * A host that begins with `[` is refused at once and is not extended.
 * `test/url-host.parser.test.ts` times the real parser to hold this.
 */
function specialHostLength(
  text: string,
  afterColon: number,
  limit: number,
): number {
  let start = afterColon;
  while (start < limit && isSeparator(text.charCodeAt(start))) start += 1;
  const end = authorityEnd(text, start, limit);
  const lastAtSign = text.lastIndexOf('@', end - 1);
  const hostStart = lastAtSign >= start ? lastAtSign + 1 : start;
  let insideBrackets = false;
  let stop = hostStart;
  for (; stop < end; stop += 1) {
    const unit = text.charCodeAt(stop);
    if (unit === COLON && !insideBrackets) break;
    if (unit === OPENING_BRACKET) insideBrackets = true;
    else if (unit === CLOSING_BRACKET) insideBrackets = false;
  }
  if (insideBrackets && text.charCodeAt(hostStart) !== OPENING_BRACKET) {
    const hash = text.indexOf('#', stop);
    return (hash === -1 || hash > limit ? limit : hash) - hostStart;
  }
  return stop - hostStart;
}

/**
 * The length, in UTF-16 code units, of the text the URL parser's host parser
 * would be given for `address`, as it is written; 0 when the parser would not
 * call it, or when the scheme is not one whose host it spends time on.
 *
 * It follows the parser's states. Leading and trailing C0 controls and spaces
 * are stripped, and tabs and newlines removed. A scheme is letters, digits,
 * `+`, `-` and `.` and a colon, in any case. For `file` the host is read as the
 * file host state reads it. For `ftp`, `http`, `https`, `ws` and `wss` it is
 * read as the authority and host states read it. A `blob:` address has an
 * address as its path, which its `origin` parses again, so the path is read the
 * same way. Any other scheme has an opaque host, and 0 is the answer.
 *
 * The count is of the host as written. A percent-escaped host is longer than
 * the name it decodes to, so it is withheld at least as soon; the parser has
 * done its work on the decoded name.
 */
export function writtenHostLength(address: string): number {
  const text = parserInput(address);
  let from = 0;
  let limit = text.length;
  let pathEndFound = false;
  for (;;) {
    while (from < limit && text.charCodeAt(from) <= SPACE) from += 1;
    SCHEME.lastIndex = from;
    const scheme = SCHEME.exec(text);
    if (scheme === null || from + scheme[0].length > limit) return 0;
    const afterColon = from + scheme[0].length;
    const name = text.slice(from, afterColon - 1).toLowerCase();
    if (name === 'blob') {
      // The path is what follows up to a `?` or `#`, and is parsed on its own.
      // Once is enough: a later blob starts after it, and ends where it ends.
      if (!pathEndFound) {
        pathEndFound = true;
        OPAQUE_PATH_END.lastIndex = afterColon;
        limit = Math.min(OPAQUE_PATH_END.exec(text)?.index ?? limit, limit);
      }
      while (limit > afterColon && text.charCodeAt(limit - 1) <= SPACE)
        limit -= 1;
      from = afterColon;
      continue;
    }
    if (name === 'file') return fileHostLength(text, afterColon, limit);
    return SPECIAL_SCHEMES.has(name)
      ? specialHostLength(text, afterColon, limit)
      : 0;
  }
}

/** Whether the host of an address, as written, is longer than a DNS name can be. */
export function hasOverlongHost(address: string): boolean {
  return writtenHostLength(address) > LONGEST_HOST_LENGTH;
}
