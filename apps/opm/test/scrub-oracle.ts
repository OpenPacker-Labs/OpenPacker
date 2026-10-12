/**
 * What `scrub` must give, as an independent statement: the first version's
 * answer (`scrub-legacy.ts`) with three differences, two in how a URL is shown.
 *
 * 1. A URL whose scheme is special (`file` included) and whose host, as Node's
 *    URL parser reads it, is longer than 253 characters is withheld as `[url]`
 *    and never reaches the URL parser, which takes the square of the host's
 *    length on a host of many non-ASCII labels (95 s of CPU for 524,295
 *    characters).
 * 2. A URL is shown at most twice as long as the text it came from, and at most
 *    600 characters: the parser writes a character outside ASCII as up to nine,
 *    and a mebibyte of path was nine mebibytes. What is cut ends in `…`.
 *
 * 3. The whole answer is at most twice as long as the text, and ends in `…`
 *    where it is cut. A URL is cut already, but the other two passes lengthen
 *    their match: `token=x,` repeated came out 2.125 times as long.
 *
 * Every other URL, and everything that is not a URL, is treated as the first
 * version treated it.
 *
 * The host is found by `packages/canonical/test/whatwg-host.ts`, which runs
 * the standard's parser states over code points (and states the one place where
 * Node's parser reads a host further than the standard does). It shares nothing
 * with the code under test, which reads the same text with index arithmetic, so
 * a mistake in one is a disagreement with the other. (The first oracle here was
 * a regular expression written from the same model as the code, and agreed with
 * it where both were wrong: a `[` in a host, and `file:`.)
 */
import { specialHostLength } from '../../../packages/canonical/test/whatwg-host.js';

export const LONGEST_HOST = 253;

const URL_MATCH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/giu;

/** The length of the text the URL parser's host parser is given for a URL match. */
export function hostLength(match: string): number {
  return specialHostLength(match);
}

/** Whether the text holds a URL whose host is longer than a DNS name can be. */
export function holdsOverlongHost(text: string): boolean {
  return [...text.matchAll(URL_MATCH)].some(
    (match) => hostLength(match[0]) > LONGEST_HOST,
  );
}

/** What the first version showed for a URL match that is not withheld. */
function firstVersionUrl(match: string): string {
  try {
    const url = new URL(match);
    return url.origin === 'null'
      ? `${url.protocol}//${url.host}${url.pathname}`
      : `${url.origin}${url.pathname}`;
  } catch {
    return '[url]';
  }
}

export const MOST_URL_CHARACTERS = 600;

/** Difference 2: a URL is shown at most twice its own length, and at most 600. */
function cut(shown: string, match: string): string {
  const limit = Math.min(2 * match.length, MOST_URL_CHARACTERS);
  return shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown;
}

/** Whether the text holds a URL that is shown cut, and not withheld. */
export function holdsCutUrl(text: string): boolean {
  return [...text.matchAll(URL_MATCH)].some((match) => {
    if (hostLength(match[0]) > LONGEST_HOST) return false;
    const shown = firstVersionUrl(match[0]);
    return cut(shown, match[0]) !== shown;
  });
}

/** Difference 3: the answer, cut at twice the length of the text. */
function atMostTwice(answer: string, text: string): string {
  const limit = 2 * text.length;
  return answer.length > limit ? `${answer.slice(0, limit - 1)}…` : answer;
}

/** The answer before difference 3. */
function uncapped(text: string): string {
  return text
    .replace(URL_MATCH, (match) =>
      hostLength(match) > LONGEST_HOST
        ? '[url]'
        : cut(firstVersionUrl(match), match),
    )
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

export function expectedScrub(text: string): string {
  return atMostTwice(uncapped(text), text);
}

/** Whether the answer for the text is cut, as a whole, at twice its length. */
export function holdsCutAnswer(text: string): boolean {
  return uncapped(text).length > 2 * text.length;
}
