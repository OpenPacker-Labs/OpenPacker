import { hasOverlongHost, redactUrl } from '@openpacker/adapter-core';

/**
 * Withhold what must not reach a terminal, a log or a pasted bug report.
 *
 * Three passes, in this order: a URL keeps its origin and path (cut at twice its
 * length and 600 characters) and loses userinfo, query and fragment, or is
 * withheld whole as `[url]` when the URL parser refuses it or its host is longer
 * than a DNS name can be; the value after a credential-shaped name is withheld;
 * a bearer or basic token is withheld.
 *
 * The text is a registry's to choose (an uncoded error carries whatever its
 * message held), so no pass may take longer than the text is long. A pass that
 * starts a scan at every word boundary of a long run such as `a-a-a-…` and
 * reads to the end of the run each time does not: 80,000 characters of `a-`
 * took 12 seconds. So the URL pass finds each `://` first and reads its scheme
 * backwards, and the credential pass starts at the name, because what comes
 * before the name is copied unchanged. The text withheld is what the single
 * expressions these replace withheld, byte for byte
 * (`scrub-differential.test.ts` holds it against them), and
 * `scrub-linear.test.ts` bounds the time.
 */
export function scrub(text: string): string {
  return withholdBearers(withholdCredentials(redactUrls(text)));
}

const CREDENTIAL =
  /(authorization|token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;'")\]]+/giu;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
/** What ends a URL: white space and the characters that close one in prose. */
const URL_END = /[\s'"<>)\]]/gu;

function withholdCredentials(text: string): string {
  return text.replace(
    CREDENTIAL,
    (_match, name: string, separator: string) =>
      `${name}${separator}[REDACTED]`,
  );
}

function withholdBearers(text: string): string {
  return text.replace(
    BEARER,
    (_match, scheme: string) => `${scheme} [REDACTED]`,
  );
}

/*
 * The characters the expressions above read, as UTF-16 code units. `i` with `u`
 * folds case the Unicode way, so `[a-z]` and `\w` also take U+017F (long s) and
 * U+212A (the Kelvin sign), and nothing outside the basic plane is in any of
 * them. The differential test puts every character of the basic plane in the
 * places these are read.
 */
function isLetter(unit: number): boolean {
  return (
    (unit >= 0x61 && unit <= 0x7a) ||
    (unit >= 0x41 && unit <= 0x5a) ||
    unit === 0x17f ||
    unit === 0x212a
  );
}

function isDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

/** `[a-z0-9+.-]`, what a scheme after its first letter is made of. */
function isSchemeUnit(unit: number): boolean {
  return (
    isLetter(unit) ||
    isDigit(unit) ||
    unit === 0x2b ||
    unit === 0x2d ||
    unit === 0x2e
  );
}

/** `\w`. NaN, what `charCodeAt` answers before the start, is not one. */
function isWordUnit(unit: number): boolean {
  return isLetter(unit) || isDigit(unit) || unit === 0x5f;
}

/**
 * Where the scheme of the URL whose `://` is at `colon` starts, or -1 if no
 * URL ends there. A scheme is a letter at a word boundary followed by scheme
 * characters up to the colon, so its start is in the run of scheme characters
 * that ends at the colon, and the regular expression took the first such start.
 * The run cannot reach back into the URL before it: that one ended at a
 * character that is not a scheme character (white space, a quote, a bracket) or
 * at the end of the text.
 */
function schemeStart(text: string, colon: number): number {
  let start = -1;
  for (let at = colon - 1; isSchemeUnit(text.charCodeAt(at)); at -= 1)
    if (isLetter(text.charCodeAt(at)) && !isWordUnit(text.charCodeAt(at - 1)))
      start = at;
  return start;
}

/** The end of the URL body that begins at `from`: the first character that ends it. */
function urlEnd(text: string, from: number): number {
  URL_END.lastIndex = from;
  return URL_END.exec(text)?.index ?? text.length;
}

/** The most one URL is shown at, whatever it holds. */
const MOST_URL_CHARACTERS = 600;

/**
 * A URL as it is shown: no longer than twice the text it came from, and never
 * more than 600 characters. The parser writes a character outside ASCII as up to
 * nine (`日` is `%E6%97%A5`), so a URL was shown at up to nine times its length,
 * and a mebibyte of path was nine. What is cut ends in `…`.
 */
function shown(out: string, match: string): string {
  const limit = Math.min(2 * match.length, MOST_URL_CHARACTERS);
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

function redactUrlText(match: string): string {
  // No DNS name is longer than 253 characters, and Node's URL parser takes the
  // square of the length of a host made of many non-ASCII labels (37 seconds
  // for 524,295 characters), so such a URL is withheld whole, unread.
  if (hasOverlongHost(match)) return '[url]';
  try {
    const url = new URL(match);
    // A URL with an opaque origin (`socks5://…`) still has a host.
    return shown(
      url.origin === 'null'
        ? `${url.protocol}//${url.host}${url.pathname}`
        : redactUrl(url),
      match,
    );
  } catch {
    return '[url]';
  }
}

/**
 * Every `scheme://body` replaced by its redacted form. Each `://` is looked at
 * once, from the left, and the text a URL took is not looked at again, so the
 * work is the length of the text plus the length of the runs read backwards,
 * which do not overlap: a run ends at the colon that follows it.
 */
function redactUrls(text: string): string {
  let out = '';
  let taken = 0;
  let colon = text.indexOf('://');
  while (colon !== -1) {
    const start = schemeStart(text, colon);
    const end = start === -1 ? colon : urlEnd(text, colon + 3);
    if (end > colon + 3) {
      out += text.slice(taken, start) + redactUrlText(text.slice(start, end));
      taken = end;
      colon = text.indexOf('://', end);
    } else colon = text.indexOf('://', colon + 1);
  }
  return taken === 0 ? text : out + text.slice(taken);
}
