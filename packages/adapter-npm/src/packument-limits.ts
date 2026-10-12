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
 * A wider look the same day (4,887 names, the full packument of the 400 with the
 * largest abbreviated one) found larger documents, and they are what the bounds
 * below rest on:
 *
 * | package                      | abbreviated | values    | full       | values    |
 * | ---------------------------- | ----------- | --------- | ---------- | --------- |
 * | public-unscoped-test-package | 38,335,911  |           | 62,061,474 |           |
 * | @prisma/client               | 38,178,921  | 1,077,961 | 68,527,188 | 2,127,695 |
 * | @wix/wix-code-types          | 27,197,598  |           | 76,503,820 | 2,655,900 |
 *
 * The bound used to be 8 MiB, which refused all six of the first, and a parsed
 * document used to be allowed 200,000 values, which refused `next`, `gatsby`,
 * `@ionic/core` and `typescript` even when the bytes were let through. ADR 44
 * has the rest, including what a hostile document of this size costs to parse.
 */
import { safeEcho } from '@openpacker/canonical';
import {
  MAXIMUM_METADATA_BYTES,
  MetadataLimitError,
  ProviderError,
  ResponseTooLargeError,
  metadataValueLimit,
  type ProviderMetadataLimits,
} from '@openpacker/adapter-core';

/**
 * The most an abbreviated packument may weigh: 64 MiB, 1.75 times the largest
 * found (38,335,911 bytes), 2.6 times `next` and 7.7 times `typescript`. At last
 * year's pace `next` (11.7 years) and `@prisma/client` (12.6) have about twelve
 * years of room; a package that publishes a version for every change has less
 * (`renovate`, 2.9 years). Below the 128 MiB an artifact download may weigh,
 * so the bytes a hostile registry can make the client hold for one packument
 * are no more than for one tarball. That bounds bytes. What parsing them costs
 * (2,169 to 2,683 MiB in 22.5 to 30.4 s for the shape that held the most,
 * 1,412 to 1,547 MiB in 52.2 to 60.8 s for the slowest, over the runs made), and
 * what a resolve keeps of the packuments it has read, are not bounded by it.
 * ADR 44 has the shapes and the full bound's figures.
 */
export const MAXIMUM_PACKUMENT_BYTES = MAXIMUM_METADATA_BYTES;

/**
 * The most the full packument (`application/json`) may weigh: 96 MiB. It is read
 * only for the publish times in it, once per package that changed within the
 * release-age window, and is several times the abbreviated one (`vite`: 39 MB
 * against 2.3 MB). The largest found is 76,503,820 bytes (`@wix/wix-code-types`)
 * and then 68,527,188 (`@prisma/client`), so 96 MiB is 1.31 times the largest
 * and 64 MiB would refuse both.
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

/** The longest an npm package name may be, scope and slash included. */
const NPM_NAME_LIMIT = 214;

/**
 * A refusal from the transport or the parser, said in terms of the package
 * that was being read. Any other refusal is returned as it came. The name is
 * made safe to echo: a dependency's name comes from a registry's document, and
 * it ends up in a message a terminal and a policy report will show.
 */
export function aboutPackument(
  name: string,
  error: ProviderError,
  document: 'packument' | 'full packument' = 'packument',
): ProviderError {
  const subject = `The ${document} of ${safeEcho(name, NPM_NAME_LIMIT)}`;
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
