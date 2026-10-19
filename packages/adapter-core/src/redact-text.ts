import { plainLine } from '@openpacker/canonical';
import { redactAddress } from './redact-address.js';

/**
 * Text that reads as an address and not as a path: a scheme of two characters
 * or more (`git+https:`, `github:`), a single letter and a colon that is not a
 * drive (`a:pw@host`, a user name), or `user@host:`, the scp form.
 */
const ADDRESS_START =
  /^(?:[A-Za-z][A-Za-z0-9+.-]+:|[A-Za-z]:(?![\\/])|[^\\/:]*@[^\\/:]*:)/u;
const SCHEME_CHARACTER = /[A-Za-z0-9+.-]/u;
const LETTER = /[A-Za-z]/u;
const SPACE = /\s/u;

/**
 * Whether a text a person or a lock wrote is an address. The URL parser removes
 * tabs and line breaks anywhere in a text and the spaces and controls before
 * it, so they are removed here before the start is read.
 */
export function isAddress(text: string): boolean {
  return ADDRESS_START.test(
    // eslint-disable-next-line no-control-regex
    text.replace(/[\t\n\r]/gu, '').replace(/^[\x00-\x20]+/u, ''),
  );
}

/**
 * `text` with each `scheme://...` in it, up to the next space, shown as
 * `redactAddress` shows an address. Linear: the scheme is read backwards from
 * each `://` (at most 32 characters) and the address forwards, and the next
 * search begins where the address ended.
 */
function redactEmbedded(text: string): string {
  let at = text.indexOf('://');
  if (at === -1) return text;
  let shown = '';
  let from = 0;
  while (at !== -1) {
    let start = at;
    while (
      start > from &&
      at - start < 32 &&
      SCHEME_CHARACTER.test(text[start - 1]!)
    )
      start -= 1;
    while (start < at && !LETTER.test(text[start]!)) start += 1;
    if (start === at) {
      at = text.indexOf('://', at + 3);
      continue;
    }
    let end = at + 3;
    while (end < text.length && !SPACE.test(text[end]!)) end += 1;
    shown += text.slice(from, start) + redactAddress(text.slice(start, end));
    from = end;
    at = text.indexOf('://', end);
  }
  return shown + text.slice(from);
}

/**
 * A value from a document (a lock's version, name, link target or path) that a
 * message repeats, shown without the credentials an address in it may hold.
 *
 * It is read as a terminal would show it (escape sequences and control,
 * format and bidirectional characters gone, one line), because the writer of an
 * error removes those and a credential they were splitting is whole again. A
 * value that is an address is shown by `redactAddress`; one that holds
 * `scheme://...` somewhere has that address, up to the next space, shown by it;
 * any other value is returned as it is, hidden characters included, for the
 * caller to show or remove. A credential that holds a space ends the address
 * there, and one that is not next to a `scheme://` or at the start of the
 * value (`pkg:token@host`) is not found.
 */
export function redactText(text: string): string {
  const view = plainLine(text);
  const shown = isAddress(view) ? redactAddress(view) : redactEmbedded(view);
  return shown === view ? text : shown;
}
