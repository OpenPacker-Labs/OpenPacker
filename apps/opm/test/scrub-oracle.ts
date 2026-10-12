/**
 * What `scrub` must give, as an independent statement: the first version's
 * answer (`scrub-legacy.ts`) with one difference. A URL whose host, as written,
 * is longer than 253 characters is withheld as `[url]` and never reaches the URL
 * parser, which takes the square of the host's length on a host of many
 * non-ASCII labels (37 s for 524,295 characters). Every other URL, and
 * everything that is not a URL, is treated as the first version treated it.
 *
 * The host is found here by a regular expression, not by the index arithmetic of
 * the code under test. A URL match holds no white space and starts at its
 * scheme, so none of the parser's edge handling is needed: after the scheme's
 * colon come slashes and backslashes, then the authority up to the next `/`,
 * `\`, `?` or `#`; its userinfo ends at the last `@`; the host is the rest up to
 * the `:` that begins a port, or a bracketed host up to its `]`.
 */
export const LONGEST_HOST = 253;

const URL_MATCH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/giu;
const HOST = /^[^:]*:[/\\]*(?:[^/\\?#]*@)?(\[[^\]/\\?#]*\]?|[^/\\?#:]*)/u;

/** The length of the host a URL match names, as written. */
export function hostLength(match: string): number {
  return HOST.exec(match)?.[1]?.length ?? 0;
}

/** Whether the text holds a URL whose host is longer than a DNS name can be. */
export function holdsOverlongHost(text: string): boolean {
  return [...text.matchAll(URL_MATCH)].some(
    (match) => hostLength(match[0]) > LONGEST_HOST,
  );
}

export function expectedScrub(text: string): string {
  return text
    .replace(URL_MATCH, (match) => {
      if (hostLength(match) > LONGEST_HOST) return '[url]';
      try {
        const url = new URL(match);
        return url.origin === 'null'
          ? `${url.protocol}//${url.host}${url.pathname}`
          : `${url.origin}${url.pathname}`;
      } catch {
        return '[url]';
      }
    })
    .replace(
      /\b([\w-]*(?:authorization|token|secret|password|passwd|api[_-]?key))(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;'")\]]+/giu,
      (_match, name: string, separator: string) =>
        `${name}${separator}[REDACTED]`,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
      (_match, scheme: string) => `${scheme} [REDACTED]`,
    );
}
