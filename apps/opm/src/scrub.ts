import { redactUrl } from '@openpacker/adapter-core';

/** Withhold what must not reach a terminal, a log or a pasted bug report. */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/giu, (match) => {
      try {
        const url = new URL(match);
        // A URL with an opaque origin (`socks5://…`) still has a host.
        return url.origin === 'null'
          ? `${url.protocol}//${url.host}${url.pathname}`
          : redactUrl(url);
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
