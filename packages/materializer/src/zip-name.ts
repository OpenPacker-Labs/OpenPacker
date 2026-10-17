/** The name of a zip entry whose UTF-8 flag is set: strict UTF-8, or a typed refusal. */

import { unsafe } from './errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function zipName(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw unsafe('INVALID_ZIP_NAME', 'a zip entry name is not valid UTF-8');
  }
}
