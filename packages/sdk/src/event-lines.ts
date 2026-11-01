import {
  CanonicalJsonLimitError,
  documentParseLimits,
  parseCanonicalJsonCosted,
} from '@openpacker/canonical';
import type { OpenPackerCloudEvent } from '@openpacker/contracts';

/**
 * The events of one page, parsed under what the page may cost to hold as a
 * whole: as much as a document of the page's byte bound
 * (`documentParseLimits`, 256 MiB for 16 MiB). An event is a small document,
 * but its bytes are the server's, and a line of `{"1023":0}` costs thousands
 * of times its length (ADR 0044, "Documents other than packuments").
 */
export function parseEventLines(
  lines: readonly string[],
  pageBytes: number,
): { event: OpenPackerCloudEvent; rawBytes: Uint8Array }[] {
  const limit = documentParseLimits(pageBytes).maximumCost;
  let spent = 0;
  try {
    return lines.map((line) => {
      const parsed = parseCanonicalJsonCosted<OpenPackerCloudEvent>(line, {
        maximumCost: limit - spent,
      });
      spent += parsed.cost;
      return { event: parsed.value, rawBytes: new TextEncoder().encode(line) };
    });
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError && error.limit === 'cost')
      throw new RangeError(
        `PREX event page would cost more than ${limit} bytes to hold`,
      );
    throw error;
  }
}
