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

export function unsafe(code: string, detail: string): MaterializationError {
  return new MaterializationError(
    code,
    `Unsafe archive rejected (${code}): ${detail}`,
  );
}
