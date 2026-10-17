/**
 * The fields of a tar header as the materializer reads them: text up to its
 * first NUL, strict UTF-8; octal numbers, nothing else; and the checksum over
 * the 8 bytes of its field (ustar).
 */

import { MaterializationError, unsafe } from './errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function tarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

export function tarNumber(bytes: Uint8Array): number {
  if ((bytes[0] ?? 0) >= 0x80)
    throw new MaterializationError(
      'ADAPTER_REQUIRED',
      'Base-256 tar numbers require an ecosystem adapter',
    );
  const text = tarText(bytes).trim();
  if (!/^[0-7]*$/u.test(text)) throw unsafe('INVALID_TAR_NUMBER', text);
  const value = Number.parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value) || value < 0)
    throw unsafe('INVALID_TAR_NUMBER', text);
  return value;
}

export function verifyTarChecksum(header: Uint8Array): void {
  const expected = tarNumber(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < header.length; index += 1)
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  if (sum !== expected) throw unsafe('TAR_CHECKSUM_MISMATCH', `${sum}`);
}
