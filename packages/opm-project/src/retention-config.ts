import { DEFAULT_RETAINED_BYTES } from '@openpacker/adapter-core';
import { OpmError } from './types.js';

const ENV = 'OPM_RETAINED_METADATA_MIB';
const MiB = 1024 * 1024;

/**
 * What a resolve may keep of the registry documents it reads, from the
 * environment: whole mebibytes, `0` to keep none, or `unlimited`. Absent or
 * empty is the default of 256 MiB. Anything else is an error rather than a
 * silent default, because a typo that quietly removed the bound would be a
 * bound that is not there.
 */
export function retainedMetadataBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RETAINED_BYTES;
  if (raw.toLowerCase() === 'unlimited') return Number.POSITIVE_INFINITY;
  if (!/^\d{1,9}$/u.test(raw))
    throw new OpmError(
      'USAGE',
      `${ENV} must be a whole number of MiB or "unlimited", not "${raw.slice(0, 40)}".`,
    );
  return Number(raw) * MiB;
}
