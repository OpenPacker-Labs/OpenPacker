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
