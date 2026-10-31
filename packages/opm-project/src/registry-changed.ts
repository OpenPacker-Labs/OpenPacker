/**
 * Whether `error` says the registry changed a document while the resolve was
 * reading it (`STALE_METADATA`): the memo or a provider read a document again
 * and it was not the one it had let go. No package is to blame, so the walk
 * does not record it as one it could not use: the resolve stops, and says so.
 */
export function isChangedUnderTheResolve(
  error: unknown,
): error is Error & { code: 'STALE_METADATA' } {
  return (
    error instanceof Error && 'code' in error && error.code === 'STALE_METADATA'
  );
}
