import { safeEcho } from '@openpacker/canonical';

/**
 * Text from a document, as a message repeats it.
 *
 * A name, a version, a range or a digest algorithm in an error came from a
 * registry's document, and what writes the error (a terminal, a log, a report)
 * cannot tell a line opm wrote from a line the registry added. `safeEcho`
 * makes the text one line with no escape sequence or control character in it,
 * and cuts what is long, saying how long it was. Text without those is
 * returned as it is, so an ordinary name reads as it always did.
 */

/** Long enough for a package URL with a version and a qualifier or two. */
export const ECHO_TEXT_LIMIT = 256;

/** `text`, as a message may repeat it. */
export function echoed(text: string, limit = ECHO_TEXT_LIMIT): string {
  return safeEcho(text, limit);
}
