import { printable, safeEcho } from '@openpacker/canonical';

/** How much of a document's text one message repeats. */
export const SHOWN_LIMIT = 256;

/**
 * Text from a signed statement, a release list, a certificate or a registry, as
 * a message repeats it: one line, no escape sequence, control, format or
 * bidirectional character, and at most 256 characters, with the original length
 * said when it was cut. A name, a tag, a reason or an identity is the vendor's
 * (or the forge's) to word, and a message goes to a terminal, a log and a
 * policy report, none of which can tell a line opm wrote from one the vendor
 * added. Text without those is returned as it is.
 */
export function shown(
  text: string | number | undefined,
  limit = SHOWN_LIMIT,
): string {
  return safeEcho(printable(text), limit);
}
