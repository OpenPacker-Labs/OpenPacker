/** A failure a provider names by its code, with the upstream's HTTP status when it has one. */
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
