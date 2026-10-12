/**
 * The orderings the layout planner uses to make every choice repeatable.
 */

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Numeric-aware, not full semver: only ever used to make a choice repeatable. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string) =>
    value
      .split(/[.+-]/u)
      .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    if (x === undefined) return typeof y === 'string' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return compareText(String(x), String(y));
  }
  return 0;
}
