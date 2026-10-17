/**
 * The one order the model's lists are in: by code unit, which no locale changes.
 * `parsePnpmLock` puts every list in it, and the lists derived from a model
 * (the summary's, the exotic sources, the orphans) are put in it again, so they
 * are a function of what the lock holds and not of the order a `PnpmLock` was
 * built in.
 */

/** Code unit order, which no locale changes. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
