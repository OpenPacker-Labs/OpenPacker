import { safeEcho } from '@openpacker/canonical';

/** Why the materializer refused an archive: a stable code and its own words. */
export class MaterializationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MaterializationError';
  }
}

/**
 * An archive was refused. The detail is usually a name from the archive, which
 * is a registry's to choose: one line, with no escape sequence in it, and cut.
 */
export function unsafe(code: string, detail: string): MaterializationError {
  return new MaterializationError(
    code,
    `Unsafe archive rejected (${code}): ${safeEcho(detail, 256)}`,
  );
}
