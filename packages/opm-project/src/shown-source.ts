import { echoed, redactAddress } from '@openpacker/adapter-core';

/**
 * Text that reads as an address and not as a path: a scheme of two characters
 * or more (`git+https:`, `github:`), a single letter and a colon that is not a
 * drive (`a:pw@host`, a user name), or `user@host:`, the scp form. The URL
 * parser removes tabs and line breaks anywhere in a text and the spaces and
 * controls before it, so they are removed here before the shape is read.
 */
const ADDRESS_START =
  /^(?:[A-Za-z][A-Za-z0-9+.-]+:|[A-Za-z]:(?![\\/])|[^\\/:]*@[^\\/:]*:)/u;

/** Whether a `source` a person wrote is an address, as the URL parser would read it. */
export function isAddress(source: string): boolean {
  return ADDRESS_START.test(
    // eslint-disable-next-line no-control-regex
    source.replace(/[\t\n\r]/gu, '').replace(/^[\x00-\x20]+/u, ''),
  );
}

/**
 * A `source` a person wrote in `opm.toml` or gave to `opm add --source`, as an
 * error may show it. Every other address opm shows is `redactAddress`: the
 * scheme, the host and the path, never userinfo, query or fragment, and a fixed
 * word where the text cannot be read as one. A source that is an address is
 * shown that way, whichever way it is read afterwards, and a `file:` source,
 * which names a file, by that file. Text that is not an address is a path on this
 * machine and is the person's own: it is named as it is written (`path`, the
 * file it was read as, when there is one).
 */
export function shownSource(source: string, path?: string): string {
  if (path !== undefined && /^\s*file:/iu.test(source))
    return echoed(path, 1024);
  if (isAddress(source)) return redactAddress(source);
  return echoed(path ?? source, 1024);
}
