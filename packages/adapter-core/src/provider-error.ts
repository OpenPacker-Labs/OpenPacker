export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
<<<<<<< ours
=======

/** The refusal for a registry's answer that is not a success. */
export function providerErrorForStatus(status: number): ProviderError {
  if (status === 404)
    return new ProviderError(
      'PACKAGE_NOT_FOUND',
      'Upstream resource was not found',
      status,
    );
  if (status === 429)
    return new ProviderError(
      'RATE_LIMITED',
      'Upstream rate limit exceeded',
      status,
    );
  return new ProviderError(
    'UPSTREAM_UNAVAILABLE',
    `Upstream returned ${status}`,
    status,
  );
}
>>>>>>> theirs
