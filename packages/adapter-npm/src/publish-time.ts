import {
  isDocumentRefusal,
  json,
  type HttpTransport,
} from '@openpacker/adapter-core';
import type { PackumentRecord } from './held-packuments.js';
import type { PublishTimeEvidence } from './index.js';
import {
  FULL_PACKUMENT_LIMITS,
  MAXIMUM_FULL_PACKUMENT_BYTES,
  aboutPackument,
} from './packument-limits.js';

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/** What a publish time is read from: `NpmRegistryProvider.publishTime`. */
export class PublishTimes {
  /** The full packument's `time` of each package, read once. */
  readonly #full = new Map<
    string,
    Promise<Record<string, string> | undefined>
  >();

  constructor(
    private readonly transport: HttpTransport,
    private readonly endpoint: string,
    private readonly packument: (
      base: string,
      signal?: AbortSignal,
    ) => Promise<PackumentRecord>,
  ) {}

  async of(
    base: string,
    name: string,
    version: string,
    needed: { settledBefore?: string },
    signal?: AbortSignal,
  ): Promise<PublishTimeEvidence | undefined> {
    // What the abbreviated document says is read in a frame of its own, which
    // has ended before the full document is read: this one waits for that,
    // and would hold the abbreviated tree while the full one is parsed.
    const settled = await this.abbreviated(base, version, needed, signal);
    if (settled !== undefined) return settled;
    let pending = this.#full.get(base);
    if (pending === undefined) {
      pending = this.full(name, signal);
      this.#full.set(base, pending);
    }
    const times = await pending;
    const exact = times?.[version];
    return isTimestamp(exact)
      ? { publishedAt: exact, source: 'full-packument' }
      : undefined;
  }

  private async abbreviated(
    base: string,
    version: string,
    needed: { settledBefore?: string },
    signal?: AbortSignal,
  ): Promise<PublishTimeEvidence | undefined> {
    const { body } = await this.packument(base, signal);
    const listed = body.time?.[version];
    if (isTimestamp(listed))
      return { publishedAt: listed, source: 'packument-time' };
    const modified = body.modified;
    if (
      needed.settledBefore !== undefined &&
      isTimestamp(modified) &&
      Date.parse(modified) <= Date.parse(needed.settledBefore)
    )
      return { publishedNoLaterThan: modified, source: 'packument-modified' };
    return undefined;
  }

  private async full(
    name: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    try {
      const response = await this.transport.request({
        url: `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(name)}`,
        signal,
        maximumBytes: MAXIMUM_FULL_PACKUMENT_BYTES,
        headers: { accept: 'application/json' },
      });
      return json<{ time?: Record<string, string> }>(
        response,
        FULL_PACKUMENT_LIMITS,
      ).time;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A document refused for its size or shape is a fact about it, and the
      // caller needs it to say why no time was had. A registry that is down or
      // answers with an error is not: that stays "no time", as it always was.
      if (isDocumentRefusal(error))
        throw aboutPackument(name, error, 'full packument');
      return undefined;
    }
  }
}
