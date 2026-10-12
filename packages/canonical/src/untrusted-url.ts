import { hasOverlongHost, LONGEST_HOST_LENGTH } from './url-host.js';

/**
 * Reading a URL that a registry, a lock, a manifest or a network peer wrote.
 *
 * `new URL` takes the square of the length of a special scheme's host when the
 * host is made of many non-ASCII labels (ADR 0044: 65,550 characters take about
 * 0.7 s, 131,000 take several), and no such host can be a DNS name. Every place
 * that parses a URL from text someone else chose therefore goes through
 * `parseUntrustedUrl`, which asks `hasOverlongHost` first. A repository test
 * (`apps/opm/test/untrusted-url-sites.test.ts`) fails on a `new URL(` anywhere
 * in `packages/*` or `apps/*` that is not routed through it or named, with its
 * reason, as one that reads a constant.
 */

/**
 * The refusal of an address whose host no DNS name could be. It is a
 * `TypeError`, as the refusal of `new URL` is, so that a caller that catches
 * the one catches the other, and its message says what was refused without
 * repeating any of it: the address is hostile text, and is not kept on the
 * error either (Node's own `ERR_INVALID_URL` carries it as `input`).
 */
export class OverlongHostError extends TypeError {
  readonly code = 'ERR_URL_HOST_TOO_LONG';

  constructor() {
    super(
      `Invalid URL: its host is longer than ${LONGEST_HOST_LENGTH} characters`,
    );
    this.name = 'OverlongHostError';
  }
}

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const SPACE = 0x20;

/**
 * Where the separators begin, if the parser reads `text` as a network-path
 * reference: two separators where a path would begin, so that what follows them
 * is a host and not a path; otherwise -1. The parser strips leading C0 controls
 * and spaces and removes tabs and newlines wherever they stand, and it reads
 * `\` as `/` after a special scheme; a scheme that does not is asked about
 * anyway, and answers that its host is opaque.
 */
function networkPathStart(text: string): number {
  let start = -1;
  let separators = 0;
  for (let index = 0; index < text.length && separators < 2; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x09 || unit === 0x0a || unit === 0x0d) continue;
    if (separators === 0 && unit <= SPACE) continue;
    if (unit !== SLASH && unit !== BACKSLASH) return -1;
    if (separators === 0) start = index;
    separators += 1;
  }
  return separators === 2 ? start : -1;
}

/**
 * `new URL(value, base)` for text that someone else chose.
 *
 * It throws what `new URL` throws, a `TypeError`, for an address the parser
 * refuses, and an `OverlongHostError` (also a `TypeError`) for one whose host,
 * as written, is longer than a DNS name can be, before the parser reads it. A
 * `base` that is text is held to the same rule. A `base` that is a `URL` was
 * parsed already, and its host is the host of whoever parsed it.
 *
 * A reference with no scheme takes its scheme from the base, so a host written
 * after two slashes (`//host/x`, `\\host`) is asked about with the base's
 * scheme in front of it. A path that happens to begin with a long segment is
 * not a host and is left alone.
 */
export function parseUntrustedUrl(value: string, base?: string | URL): URL {
  const text = String(value);
  if (hasOverlongHost(text)) throw new OverlongHostError();
  if (base === undefined) return new URL(text);
  const resolved = typeof base === 'string' ? parseUntrustedUrl(base) : base;
  const start = networkPathStart(text);
  if (
    start !== -1 &&
    hasOverlongHost(`${resolved.protocol}${text.slice(start)}`)
  )
    throw new OverlongHostError();
  return new URL(text, resolved);
}
