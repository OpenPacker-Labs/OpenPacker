/**
 * A bound on the host of an address, checked before a URL parser reads it.
 *
 * Node's `new URL` takes time that grows with the square of the length of a
 * special-scheme host made of many non-ASCII labels: `'http://' + 'ß.é.'`
 * repeated to 524,295 characters takes 37 seconds, and 65,536 characters take
 * 1.2 seconds. No such host can be a DNS name, which is at most 253 characters
 * as text, so an address whose host is longer than that is refused by the
 * callers that read an address from text a registry or a lock chose, before it
 * reaches the parser.
 */

/** The longest host name there is, in characters: 255 octets on the wire. */
export const LONGEST_HOST_LENGTH = 253;

/** What the URL parser removes wherever it is. */
const PARSER_DROPS = /[\t\n\r]/gu;
/** A scheme and its colon. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
/** What ends an authority: the parser reads `\` as `/` for special schemes. */
const AUTHORITY_END = /[/\\?#]/gu;

/** The address without the control characters and spaces the URL parser strips from its start. */
function withoutEdge(address: string): string {
  let from = 0;
  while (from < address.length && address.charCodeAt(from) <= 0x20) from += 1;
  return from === 0 ? address : address.slice(from);
}

/**
 * The length of the host an address names, as it is written, in UTF-16 code
 * units, found without the URL parser. 0 when it names none.
 *
 * It reads an address the way a special scheme does, which is where the parser
 * is slow, and is generous about what a host is. The parser's edges are
 * stripped and its dropped characters removed first. The authority is what
 * follows the scheme's colon and any run of `/` and `\` (`http:host` and
 * `http:\\host` are read as `http://host/`), up to the next `/`, `\`, `?` or
 * `#`. Its userinfo ends at the last `@`. The host is what follows, up to the
 * `:` that begins a port, or a bracketed host up to its `]`. An address of a
 * scheme with no authority (`github:o/r`) gets its first path segment as host.
 */
export function writtenHostLength(address: string): number {
  const clean = withoutEdge(address).replace(PARSER_DROPS, '');
  const scheme = SCHEME.exec(clean);
  if (scheme === null) return 0;
  let start = scheme[0].length;
  while (clean[start] === '/' || clean[start] === '\\') start += 1;
  AUTHORITY_END.lastIndex = start;
  const end = AUTHORITY_END.exec(clean)?.index ?? clean.length;
  const userinfoEnd = clean.lastIndexOf('@', end - 1);
  const hostStart = userinfoEnd >= start ? userinfoEnd + 1 : start;
  const stop =
    clean[hostStart] === '['
      ? clean.indexOf(']', hostStart)
      : clean.indexOf(':', hostStart);
  const hostEnd =
    stop === -1 || stop >= end
      ? end
      : stop + (clean[hostStart] === '[' ? 1 : 0);
  return hostEnd - hostStart;
}

/** Whether the host of an address, as written, is longer than a DNS name can be. */
export function hasOverlongHost(address: string): boolean {
  return writtenHostLength(address) > LONGEST_HOST_LENGTH;
}
