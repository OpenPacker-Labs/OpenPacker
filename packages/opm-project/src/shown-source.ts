import { echoed, isAddress, redactAddress } from '@openpacker/adapter-core';

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
