import type { HttpResponse } from '@openpacker/adapter-core';

/**
 * What `typescript` (8.7 MB, 260,520 values) and `next` (25.6 MB, 846,076) have
 * that a fixture does not: weight. The packument is served with a member the
 * walk never reads, so its size and value count are what a real one's are.
 */
export interface Padding {
  /** Serialized size of the packument, exactly. */
  bytes?: number;
  /** At least this many values (empty arrays) in the packument. */
  values?: number;
  /** Which document is heavy; the abbreviated one is read first and always. */
  only?: 'abbreviated' | 'full';
}

const encoder = new TextEncoder();

/** A packument served with the weight `padding` asks for. */
export function padded(
  document: Record<string, unknown>,
  padding: Padding,
): HttpResponse {
  const empties =
    padding.values === undefined
      ? undefined
      : Array.from({ length: padding.values }, () => []);
  const make = (fill: number) =>
    encoder.encode(
      JSON.stringify({
        ...document,
        ...(empties && { 'x-values': empties }),
        ...(padding.bytes !== undefined && { 'x-padding': 'x'.repeat(fill) }),
      }),
    );
  const body =
    padding.bytes === undefined
      ? make(0)
      : make(padding.bytes - make(0).length);
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    url: '',
  };
}
