import { hasOverlongHost } from './url-host.js';

/** A scheme and its colon, at the start of a text. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
/** Where a query or a fragment begins. */
const QUERY_OR_FRAGMENT = /[?#]/u;
/** An `@` in a path that does not begin a segment: where userinfo would end. */
const AT_IN_SEGMENT = /[^/]@/u;
/** How many blob URLs inside one another are read, one inside the next. */
const MOST_BLOBS = 4;

/**
 * An address that the URL parser does not read, with what must not be printed
 * taken out: its userinfo, then its query and fragment.
 *
 * Userinfo is what stands between the scheme (and the `//` after it) and the
 * LAST `@` of the text. A password may hold an `@`, a `?`, a `#`, a `:` or a
 * `/`, and the last `@` is the only mark that does not depend on which of them
 * it holds. The price is paid by an address that has an `@` after its host: in
 * `git+ssh://git@github.com:@scope/pkg.git` the front goes with the userinfo
 * (`git+ssh://scope/pkg.git`), and so does `git+ssh://h.example?x=a@b`
 * (`git+ssh://b`). A text with no scheme and no leading `//` has no userinfo to
 * take out.
 */
export function redactAddressText(text: string): string {
  const scheme = SCHEME.exec(text);
  let start = -1;
  if (scheme !== null)
    start =
      scheme[0].length + (text.startsWith('//', scheme[0].length) ? 2 : 0);
  else if (text.startsWith('//')) start = 2;
  const lastAtSign = text.lastIndexOf('@');
  const withoutUserinfo =
    start !== -1 && lastAtSign >= start
      ? text.slice(0, start) + text.slice(lastAtSign + 1)
      : text;
  const cut = withoutUserinfo.search(QUERY_OR_FRAGMENT);
  return cut === -1 ? withoutUserinfo : withoutUserinfo.slice(0, cut);
}

function render(address: string, blobs: number): string {
  // A host no DNS name could be is not handed to the URL parser, which takes
  // the square of its length on some (see `url-host.ts`).
  if (hasOverlongHost(address)) return '[url]';
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return redactAddressText(address);
  }
  // A blob URL holds an address as its path. Its `origin` would parse that
  // address again, and is not what is shown: the address is, redacted.
  if (url.protocol === 'blob:')
    return blobs >= MOST_BLOBS
      ? '[url]'
      : `blob:${render(url.pathname, blobs + 1)}`;
  // The parser found userinfo. It ends userinfo at the first `/`, `?` or `#`
  // (`\\` too, for a special scheme), so a password that holds one of them and
  // then an `@` is read as a host and a path, or a query, with the rest of the
  // password in them. The text rule, which ends userinfo at the last `@`, does
  // not depend on what the password holds.
  if (url.username !== '' || url.password !== '')
    return redactAddressText(address);
  // `user:123/secret@host` has a password of digits and a `/` (or a `?` or a
  // `#`), and the parser reads it as the host `user`, the port 123 and a path
  // (or a query). Userinfo needs an `@` after it, and a scoped package's `@`
  // begins a segment (`/@scope/p`), so an `@` further into a segment of the
  // path, or anywhere in the query or fragment, of an address with a host is
  // taken for the end of userinfo. A `name@version` segment pays for it.
  if (
    url.host !== '' &&
    (AT_IN_SEGMENT.test(url.pathname) ||
      url.search.includes('@') ||
      url.hash.includes('@'))
  )
    return redactAddressText(address);
  if (url.origin !== 'null') return `${url.origin}${url.pathname}`;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  // No authority and no path of slashes: the address has an opaque path, which
  // is where `user:password@host:path` and `github:user:password@owner/repo`
  // keep the userinfo the parser did not take for one.
  return url.host === '' && !url.pathname.startsWith('/')
    ? redactAddressText(url.href)
    : url.href;
}

/**
 * An address as an error may show it, for text a lock or a registry chose: the
 * address without userinfo, query and fragment, and with its scheme.
 *
 * - A host longer than a DNS name can be, where the URL parser spends time on
 *   it (`hasOverlongHost`), is shown as `[url]` and never parsed.
 * - An address in which the parser finds userinfo is cut as text, because the
 *   parser ends userinfo at the first `/`, `?` or `#` and a password can hold
 *   any of them.
 * - An address with a host whose path holds an `@` inside a segment, or whose
 *   query or fragment holds an `@`, is cut as text as well: the parser may have
 *   read a password that holds a `/`, `?` or `#` as a host, a port and the
 *   rest. A scoped package (`/@scope/p`) is not cut.
 * - An address with an origin (`https:`) is its origin and path.
 * - A `blob:` URL is `blob:` and the address in its path, shown the same way.
 * - Any other address the parser reads is shown as it serialises it, without
 *   userinfo, query and fragment (`git+https://host/o/r.git`, `file:///srv/p`),
 *   and when it has an opaque path the userinfo that may stand in it is taken
 *   out as text.
 * - An address the parser refuses is cut as text (`redactAddressText`).
 */
export function redactAddress(address: string): string {
  return render(address, 0);
}
