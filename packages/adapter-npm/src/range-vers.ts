import type { RangeAst } from '@openpacker/adapter-core';

/**
 * The comparison form of an npm range, for the solver to enforce.
 *
 * `parseNativeRange` offers a VERS only for an exact version, so every `^`,
 * `~`, `>=` or `||` range reached the solver as "any version of this package".
 * With one edge per package that went unseen, because the walk only admits
 * versions that satisfy some edge's range; with two edges that need different
 * ranges the solver took the newest of the union for both, and a lock could pair
 * a package with a version it does not accept. Ranges are a union of
 * conjunctions of comparisons, which is what this dialect of VERS says with
 * `|` (and) and `||` (or). `*` constrains nothing.
 *
 * It is a superset, not an equal: a comparison form admits a prerelease of a
 * higher version that npm's `^2.9.0` excludes. The solve's answer is therefore
 * re-checked edge by edge against the native range, and an edge it leaves unmet
 * is narrowed and solved again (see `solveGraph`).
 */
export function npmRangeVers(ast: RangeAst): string | undefined {
  const alternatives = ast.type === 'or' ? ast.items : [ast];
  const rendered: string[] = [];
  for (const alternative of alternatives) {
    if (alternative.type === 'any') return undefined;
    const clauses =
      alternative.type === 'and' ? alternative.items : [alternative];
    const parts: string[] = [];
    for (const clause of clauses) {
      if (clause.type !== 'comparison') return undefined;
      parts.push(`${clause.operator}${clause.version}`);
    }
    rendered.push(parts.join('|'));
  }
  return rendered.length === 0 ? undefined : `vers:npm/${rendered.join('||')}`;
}
