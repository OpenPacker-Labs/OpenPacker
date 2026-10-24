/**
 * What the URL Standard's basic URL parser hands to the host parser, found by
 * running its states as the standard writes them (https://url.spec.whatwg.org/
 * #concept-basic-url-parser): the scheme start, scheme, no scheme, special
 * authority slashes, special authority ignore slashes, path or authority,
 * authority, host, file, file slash and file host states, over code points, with
 * a pointer, a buffer and the two flags the states use. It stops at the first
 * call of "host parsing", which is the work Node's parser is slow at, and at any
 * state that does not lead to a host (the path states and the opaque path).
 *
 * It exists to be a second reading of the standard, written from the standard's
 * text and not from `src/url-host.ts`, so that a mistake in one is a
 * disagreement with the other. `whatwg-host.test.ts` checks it against
 * `new URL` itself on the inputs where the two can be compared.
 *
 * Left out: a base URL (`new URL(x)` has none), state overrides (the setters),
 * and everything after the host.
 */

const SPECIAL_SCHEMES = new Set(['ftp', 'file', 'http', 'https', 'ws', 'wss']);

/** A tab or newline: removed from the input wherever it is. */
function isTabOrNewline(point: string): boolean {
  return point === '\t' || point === '\n' || point === '\r';
}

/** A C0 control or space: removed from both ends of the input. */
function isC0ControlOrSpace(point: string): boolean {
  return point.codePointAt(0)! <= 0x20;
}

function isAsciiAlpha(point: string | undefined): boolean {
  return point !== undefined && /^[A-Za-z]$/u.test(point);
}

function isAsciiAlphanumeric(point: string | undefined): boolean {
  return point !== undefined && /^[A-Za-z0-9]$/u.test(point);
}

/** Two code points that are a Windows drive letter: an ASCII alpha and `:` or `|`. */
function isWindowsDriveLetter(text: string): boolean {
  return /^[A-Za-z][:|]$/u.test(text);
}

/** The code points without the C0 controls and spaces at either end. */
function withoutEdges(points: string[]): string[] {
  let first = 0;
  let last = points.length;
  while (first < last && isC0ControlOrSpace(points[first]!)) first += 1;
  while (last > first && isC0ControlOrSpace(points[last - 1]!)) last -= 1;
  return points.slice(first, last);
}

export interface HostCall {
  /** The scheme the parser settled on, lower case. */
  scheme: string;
  /** Whether it is one of the special schemes (`file` is). */
  special: boolean;
  /** The buffer the parser gives the host parser, exactly as written. */
  buffer: string;
  /** Whether the host state ended with a `[` that no `]` had closed. */
  insideBrackets: boolean;
  /** What follows the buffer in the input, from the delimiter that ended it. */
  rest: string;
}

/**
 * The host parser's input for `input`, or `undefined` when the parser fails,
 * or ends, before it would call the host parser (no scheme, an opaque path, a
 * path state, a missing host).
 */
export function hostCall(input: string): HostCall | undefined {
  // Basic URL parser, step "If url is not given": strip leading and trailing C0
  // control or space, then remove all ASCII tab or newline.
  const points = withoutEdges(Array.from(input)).filter(
    (point) => !isTabOrNewline(point),
  );

  type State =
    | 'scheme start'
    | 'scheme'
    | 'no scheme'
    | 'special authority slashes'
    | 'special authority ignore slashes'
    | 'path or authority'
    | 'authority'
    | 'host'
    | 'file'
    | 'file slash'
    | 'file host'
    | 'path'
    | 'opaque path';

  let state: State = 'scheme start';
  let buffer = '';
  let scheme = '';
  let atSignSeen = false;
  let insideBrackets = false;
  const special = () => SPECIAL_SCHEMES.has(scheme);
  const remainingStartsWith = (pointer: number, text: string) =>
    points.slice(pointer + 1, pointer + 1 + text.length).join('') === text;

  // "Keep running the following state machine by switching on state. If after
  // a run pointer points to the EOF code point, go to the next step. Otherwise,
  // increase pointer by 1 and continue with the state machine." The EOF code
  // point is the position one past the last code point; c is undefined there.
  for (let pointer = 0; ; pointer += 1) {
    const c: string | undefined = points[pointer];

    switch (state) {
      case 'scheme start':
        if (isAsciiAlpha(c)) {
          buffer += c!.toLowerCase();
          state = 'scheme';
        } else {
          // No state override: "Otherwise, set state to no scheme state and
          // decrease pointer by 1."
          state = 'no scheme';
          pointer -= 1;
        }
        break;

      case 'scheme':
        if (isAsciiAlphanumeric(c) || c === '+' || c === '-' || c === '.') {
          buffer += c!.toLowerCase();
        } else if (c === ':') {
          scheme = buffer;
          buffer = '';
          if (scheme === 'file') {
            state = 'file';
          } else if (special()) {
            state = 'special authority slashes';
          } else if (remainingStartsWith(pointer, '/')) {
            state = 'path or authority';
            pointer += 1;
          } else {
            state = 'opaque path';
          }
        } else {
          // "Otherwise, if state override is not given, set buffer to the empty
          // string, state to no scheme state, and start over (from the first
          // code point in input)."
          buffer = '';
          state = 'no scheme';
          pointer = -1;
        }
        break;

      case 'no scheme':
        // No base URL: "validation error, return failure."
        return undefined;

      case 'special authority slashes':
        if (c === '/' && remainingStartsWith(pointer, '/')) {
          state = 'special authority ignore slashes';
          pointer += 1;
        } else {
          state = 'special authority ignore slashes';
          pointer -= 1;
        }
        break;

      case 'special authority ignore slashes':
        if (c !== '/' && c !== '\\') {
          state = 'authority';
          pointer -= 1;
        }
        break;

      case 'path or authority':
        if (c === '/') {
          state = 'authority';
        } else {
          state = 'path';
          pointer -= 1;
        }
        break;

      case 'authority':
        if (c === '@') {
          // The buffer so far was the userinfo; it is not kept.
          atSignSeen = true;
          buffer = '';
        } else if (
          c === undefined ||
          c === '/' ||
          c === '?' ||
          c === '#' ||
          (special() && c === '\\')
        ) {
          if (atSignSeen && buffer === '') return undefined;
          pointer -= Array.from(buffer).length + 1;
          buffer = '';
          state = 'host';
        } else {
          buffer += c;
        }
        break;

      case 'host':
        if (c === ':' && !insideBrackets) {
          if (buffer === '') return undefined;
          return {
            scheme,
            special: special(),
            buffer,
            insideBrackets,
            rest: points.slice(pointer).join(''),
          };
        }
        if (
          c === undefined ||
          c === '/' ||
          c === '?' ||
          c === '#' ||
          (special() && c === '\\')
        ) {
          if (special() && buffer === '') return undefined;
          return {
            scheme,
            special: special(),
            buffer,
            insideBrackets,
            rest: points.slice(pointer).join(''),
          };
        }
        if (c === '[') insideBrackets = true;
        if (c === ']') insideBrackets = false;
        buffer += c;
        break;

      case 'file':
        // "Set url's scheme to 'file'. Set url's host to the empty string."
        if (c === '/' || c === '\\') {
          state = 'file slash';
        } else {
          state = 'path';
          pointer -= 1;
        }
        break;

      case 'file slash':
        if (c === '/' || c === '\\') {
          state = 'file host';
        } else {
          state = 'path';
          pointer -= 1;
        }
        break;

      case 'file host':
        if (
          c === undefined ||
          c === '/' ||
          c === '\\' ||
          c === '?' ||
          c === '#'
        ) {
          // "If state override is not given and buffer is a Windows drive
          // letter ... set state to path state"; "Otherwise, if buffer is the
          // empty string ... set url's host to the empty string"; otherwise
          // the host parser is given the buffer.
          if (isWindowsDriveLetter(buffer) || buffer === '') return undefined;
          return {
            scheme,
            special: true,
            buffer,
            insideBrackets: false,
            rest: points.slice(pointer).join(''),
          };
        }
        buffer += c;
        break;

      case 'path':
      case 'opaque path':
        return undefined;
    }

    if (pointer >= points.length) return undefined;
  }
}

/**
 * The length, in UTF-16 code units, of the text Node's parser spends time on:
 * what the host parser is given when the scheme is special. 0 for a scheme that
 * is not (its host is opaque and linear), and for anything the parser gives up
 * on before a host.
 *
 * One place where Node is not the Standard, found by timing it
 * (`url-host.parser.test.ts`): when the host buffer ends inside a `[` that no
 * `]` closed and does not begin with `[`, the Standard ends the host at the
 * authority's end, and Node's parser reads on, past `/`, `?` and `\`, to the
 * next `#` or the end of the input. That reading is what is returned.
 */
export function specialHostLength(input: string): number {
  const call = hostCall(input);
  if (call === undefined || !call.special) return 0;
  if (
    call.scheme !== 'file' &&
    call.insideBrackets &&
    !call.buffer.startsWith('[')
  ) {
    const hash = call.rest.indexOf('#');
    return call.buffer.length + (hash === -1 ? call.rest.length : hash);
  }
  return call.buffer.length;
}

/**
 * `specialHostLength`, and for `blob:` the length of the address in its path.
 * A `blob:` URL has an opaque path, which is what follows the scheme's colon up
 * to a `?` or `#`, and its `origin` runs the URL parser on that path again. The
 * path is read here as written: the parser percent-decodes it before the host
 * parser sees it, so the written length is never less than the work.
 */
export function hostLengthIncludingBlob(input: string, depth = 0): number {
  const direct = specialHostLength(input);
  if (direct > 0 || depth > 64) return direct;
  const text = withoutEdges(Array.from(input))
    .filter((point) => !isTabOrNewline(point))
    .join('');
  const match = /^blob:/iu.exec(text);
  if (match === null) return 0;
  const path = text.slice(match[0].length).split(/[?#]/u, 1)[0]!;
  return hostLengthIncludingBlob(path, depth + 1);
}
