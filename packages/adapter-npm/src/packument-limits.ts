/**
 * How much of a registry's packument the client will read.
 *
 * The bound exists so that a hostile or broken registry cannot make the client
 * allocate without limit. It must also sit above what the real registry serves,
 * and the real registry's packuments are large: one entry per version ever
 * published, `next` and `typescript` among them publish nightlies.
 *
 * Measured against registry.npmjs.org on 2026-10-12, abbreviated
 * (`application/vnd.npm.install-v1+json`), decoded, over the 50 packages with
 * the most versions that were tried:
 *
 * | package         | bytes      | values  | versions |
 * | --------------- | ---------- | ------- | -------- |
 * | next            | 25,636,598 | 846,076 | 3,986    |
 * | gatsby          | 15,734,819 | 512,428 | 2,995    |
 * | @ionic/core     | 10,128,386 | 255,914 | 4,942    |
 * | firebase        |  9,876,235 | 184,635 | 4,224    |
 * | typescript      |  8,728,082 | 260,520 | 3,850    |
 * | playwright-core |  8,418,576 | 156,979 | 5,714    |
 *
 * A document costs 27 to 54 bytes a value. The bound used to be 8 MiB, which
 * refused all six of these, and a parsed document used to be allowed 200,000
 * values, which refused `next`, `gatsby`, `@ionic/core` and `typescript` even
 * when the bytes were let through.
 */
import {
  MAXIMUM_METADATA_BYTES,
  MetadataLimitError,
  ProviderError,
  ResponseTooLargeError,
  metadataValueLimit,
  type ProviderMetadataLimits,
} from '@openpacker/adapter-core';

/**
 * The most an abbreviated packument may weigh: 64 MiB, 2.6 times `next`, the
 * largest measured, and 7.3 times `typescript`. `next` published 580 versions
 * in the year to 2026-10-12, at 6.4 KB each in this document: 3.6 MiB a year,
 * so about a decade of room, not a fit to today. Below the 128 MiB an artifact
 * download may weigh, so a hostile registry is allowed no more of the client's
 * memory by a packument than by a tarball.
 */
export const MAXIMUM_PACKUMENT_BYTES = MAXIMUM_METADATA_BYTES;

/**
 * The most the full packument (`application/json`) may weigh. It is read only
 * for the publish times in it, once per package that changed within the
 * release-age window, and is several times the abbreviated one (`vite`: 39 MB
 * against 2.3 MB, `typescript`: 15.8 MB against 8.7 MB).
 */
export const MAXIMUM_FULL_PACKUMENT_BYTES = 96 * 1024 * 1024;

/** What a parsed abbreviated packument may hold: one value per 16 bytes. */
export const PACKUMENT_LIMITS: ProviderMetadataLimits = {
  maximumNodes: metadataValueLimit(MAXIMUM_PACKUMENT_BYTES),
};

/**
 * What a parsed full packument may hold. `typescript` is 538,245 values, which
 * is why the default of 200,000 could not stay.
 */
export const FULL_PACKUMENT_LIMITS: ProviderMetadataLimits = {
  maximumNodes: metadataValueLimit(MAXIMUM_FULL_PACKUMENT_BYTES),
};

/**
 * A refusal from the transport or the parser, said in terms of the package
 * that was being read. Any other refusal is returned as it came.
 */
export function aboutPackument(
  name: string,
  error: ProviderError,
  document: 'packument' | 'full packument' = 'packument',
): ProviderError {
  const subject = `The ${document} of ${name}`;
  if (error instanceof ResponseTooLargeError) return error.about(subject);
  if (error instanceof MetadataLimitError) return error.about(subject);
  if (error.code === 'INVALID_PROVIDER_METADATA')
    return new ProviderError(
      error.code,
      `${subject} is not usable: ${error.message}`,
      error.upstreamStatus,
    );
  return error;
}
