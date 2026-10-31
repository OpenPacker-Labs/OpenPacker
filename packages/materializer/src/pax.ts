/**
 * The records of a pax extended header (POSIX.1-2001): `<length> <key>=<value>\n`
 * where the length counts the whole record, its own digits and the newline
 * included.
 *
 * A record that is not exactly that makes the whole header malformed (the
 * result is undefined), not something to read generously.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Most bytes an extended header may carry; a long path is a few hundred. */
export const MAXIMUM_PAX_HEADER_BYTES = 64 * 1024;

export function parsePaxRecords(
  data: Uint8Array,
): Map<string, string> | undefined {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.byteLength) {
    let space = at;
    while (space < data.byteLength && data[space] !== 0x20) space += 1;
    const digits = Buffer.from(data.subarray(at, space)).toString('latin1');
    if (space >= data.byteLength || !/^[1-9][0-9]{0,8}$/u.test(digits))
      return undefined;
    const end = at + Number(digits);
    // Digits, a space, at least "k=" and the newline.
    if (end > data.byteLength || end < space + 4 || data[end - 1] !== 0x0a)
      return undefined;
    let record: string;
    try {
      record = utf8.decode(data.subarray(space + 1, end - 1));
    } catch {
      return undefined;
    }
    const equals = record.indexOf('=');
    if (equals < 1) return undefined;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at = end;
  }
  return records;
}
