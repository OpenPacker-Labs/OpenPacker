import { hasOverlongHost } from './url-host.js';

/** What stands for an address the URL parser refuses, after its scheme if it has one. */
const WITHHELD = '[address withheld]';
/** What stands for an address with a host no DNS name could be, or one nested too deep. */
const OVERLONG = '[url]';
/** A scheme and its colon at the start of a text, short enough to be a scheme. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:/u;
/** Schemes whose address is a path on this machine, where an `@` is a character. */
const LOCAL_PATH_SCHEMES: ReadonlySet<string> = new Set(['file:', 'link:']);
/** How many blob URLs inside one another are read, one inside the next. */
const MOST_BLOBS = 4;
/** The most a host, and the most a path, is shown at. */
const MOST_CHARACTERS = 256;

/** `text` as it is, or its first characters and how many there were. */
function capped(text: string): string {
  return text.length <= MOST_CHARACTERS
    ? text
    : `${text.slice(0, MOST_CHARACTERS)}… (${text.length} characters)`;
}

/**
 * The scope of a scoped package: `@` and the characters npm allows in one,
 * without the dot. A host has a dot (`@registry.example.com`), a scope that
 * people use does not (`@types`, `@babel`), and a credential written raw that
 * ends in a `/` and is followed by the host of an unscoped tarball
 * (`<token>/@registry.example.com/name/-/name-1.0.0.tgz`) is the one thing the
 * dot would let through. A scope with a dot is withheld with the rest.
 */
const SCOPE = /^@[a-z0-9][a-z0-9_~-]*$/u;

/**
 * Whether a path is the path of a scoped package's tarball,
 * `<prefix>/@scope/name/-/name-<version>.tgz`, which holds one `@`, at the start
 * of the scope. Any other path that holds an `@` may be the rest of a password
 * the parser took for a port and a path.
 */
function isScopedTarballPath(pathname: string): boolean {
  const segments = pathname.split('/');
  const last = segments.length - 1;
  if (last < 4 || segments[last - 1] !== '-') return false;
  const name = segments[last - 2]!;
  const file = segments[last]!;
  if (!SCOPE.test(segments[last - 3]!)) return false;
  if (!file.startsWith(`${name}-`) || !file.endsWith('.tgz')) return false;
  return segments.every(
    (segment, index) => index === last - 3 || !segment.includes('@'),
  );
}

/**
 * Whether the part of the address after the authority holds an `@`, so that the
 * real end of userinfo may be in it. A password that holds a `/`, a `?` or a `#`
 * ends the parser's authority there, and the `@` that ends the password is then
 * in the path, the query or the fragment: `deploy:123/secret@host` is a host, a
 * port 123 and a path, and `deploy:a@b?c@host` is a user, a password `a` and a
 * host `b`. If that part holds no `@`, no password was split. A scoped
 * package's tarball path (`/@scope/name/-/file`) holds one `@`, at the start of
 * the scope, and is the one exception.
 */
function mayHoldUserinfo(url: URL): boolean {
  if (url.search.includes('@') || url.hash.includes('@')) return true;
  return url.pathname.includes('@') && !isScopedTarballPath(url.pathname);
}

/** The scheme of a text that has one, in lower case, with the fixed words after it. */
function withheld(address: string): string {
  let from = 0;
  while (from < address.length && address.charCodeAt(from) <= 0x20) from += 1;
  const scheme = SCHEME.exec(address.slice(from, from + 40));
  return scheme === null ? WITHHELD : `${scheme[0].toLowerCase()}${WITHHELD}`;
}

function render(address: string, blobs: number): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return withheld(address);
  }
  if (url.protocol === 'blob:') {
    // A blob URL holds an address as its path, shown the same way.
    if (blobs >= MOST_BLOBS) return OVERLONG;
    if (url.search.includes('@') || url.hash.includes('@'))
      return `blob:${WITHHELD}`;
    return `blob:${render(url.pathname, blobs + 1)}`;
  }
  if (url.host === '') {
    const local = LOCAL_PATH_SCHEMES.has(url.protocol);
    // An opaque path is where `user:password@host:path` keeps its userinfo, and
    // a `?` or `#` in the password leaves the `@` in the query or fragment.
    if (!local && (url.pathname + url.search + url.hash).includes('@'))
      return `${url.protocol}${WITHHELD}`;
    // The URL object written without its query and fragment: what comes before
    // the path is the parser's (`//` for an empty host, and `/.` before a path
    // that begins with `//`, so that it is not read back as a host).
    url.search = '';
    url.hash = '';
    const before = url.href.slice(0, url.href.length - url.pathname.length);
    return `${before}${capped(url.pathname)}`;
  }
  if (mayHoldUserinfo(url)) return `${url.protocol}${WITHHELD}`;
  return `${url.protocol}//${capped(url.host)}${capped(url.pathname)}`;
}

/**
 * An address as an error may show it, for text a lock, a registry or a person
 * chose. What it prints can only be:
 *
 * - the scheme;
 * - when the URL parser accepts the address, the parser's own host (with its
 *   port) and path, taken from the URL object and not from the text, each shown
 *   at 256 characters and then how many there were. Never userinfo, query or
 *   fragment, so nothing after an `@` or a `?` of the text is ever shown, and a
 *   host that is not the parser's is never shown;
 * - the fixed words `[url]` and `[address withheld]`.
 *
 * `[url]` stands for a host longer than a DNS name can be, where the URL parser
 * spends time on it (`hasOverlongHost`, asked once, of the address as written,
 * before any parser reads it), and for a `blob:` URL nested more than four deep.
 * A `blob:` URL is `blob:` and the address in its path, shown the same way.
 *
 * `[address withheld]`, after the scheme if the text has one, stands for:
 *
 * - an address the parser refuses (`git@github.com:o/r.git`,
 *   `git+ssh://git@github.com:o/r.git`, `https://u:p@ho st/x`);
 * - an address the parser accepts and in which an `@` comes after the authority,
 *   in the path, the query or the fragment, or anywhere in an opaque path: that
 *   `@` may be where userinfo ends, with the rest of a password read as a host
 *   and a path (`mayHoldUserinfo`). A scoped package's tarball path,
 *   `/@scope/name/-/file`, is the one `@` that does not count.
 *
 * `file:` and `link:` addresses are paths on this machine, where an `@` is a
 * character, and are shown without query and fragment.
 */
export function redactAddress(address: string): string {
  if (hasOverlongHost(address)) return OVERLONG;
  return render(address, 0);
}
