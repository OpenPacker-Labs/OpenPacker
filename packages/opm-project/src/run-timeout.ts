import { OpmError } from './types.js';

/**
 * The longest wall-clock limit a run can be given, in milliseconds: what a
 * timer can wait (2^31 - 1 ms, about 24.8 days). Node runs a timer set for
 * longer at once.
 */
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

/**
 * A run's wall-clock limit as written (`opmx --timeout <ms>`, `[sandbox]
 * opmx_timeout_ms`): whole milliseconds, 0 for none, up to
 * {@link MAX_RUN_TIMEOUT_MS}. Anything else is refused with `code`, naming
 * where it was written.
 */
export function parseRunTimeout(
  text: string,
  source: string,
  code = 'USAGE',
): number {
  const value = /^\d{1,10}$/u.test(text) ? Number(text) : Number.NaN;
  if (!(value >= 0 && value <= MAX_RUN_TIMEOUT_MS))
    throw new OpmError(
      code,
      `${source} takes whole milliseconds from 0 (no limit) to ${MAX_RUN_TIMEOUT_MS}, not ${JSON.stringify(text)}`,
    );
  return value;
}
