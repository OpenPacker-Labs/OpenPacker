import { echoed } from '@openpacker/adapter-core';
import { plainLine } from '@openpacker/canonical';
import type { ResolvedGraph } from './resolve.js';

/*
 * What a closure that could not be locked says it set aside. The PURLs and the
 * reasons came from registries, so each is one plain line.
 */

/** Who asked for a package, for a line of an error. */
function askedBy(requiredBy: readonly string[] | undefined): string {
  if (requiredBy === undefined || requiredBy.length === 0) return '';
  const shown = requiredBy.slice(0, 3).map((purl) => echoed(purl));
  return ` (required by ${shown.join(', ')}${requiredBy.length > 3 ? `, and ${requiredBy.length - 3} more` : ''})`;
}

/**
 * The candidates the walk had to set aside, and the ones the policy did, for an
 * error that follows from it.
 */
export function unresolvedNote(
  unresolved: ResolvedGraph['unresolved'],
  gated: ResolvedGraph['gated'],
): string {
  const list = (items: ResolvedGraph['unresolved']) =>
    items
      .slice(0, 5)
      .map(
        (item) =>
          `\n  - ${echoed(item.purl)}: ${plainLine(item.reason)}${askedBy(item.requiredBy)}`,
      )
      .join('') +
    (items.length > 5 ? `\n  - and ${items.length - 5} more` : '');
  return (
    (unresolved.length === 0
      ? ''
      : `\nWhat the walk could not use:${list(unresolved)}`) +
    (gated.length === 0 ? '' : `\nWhat the policy set aside:${list(gated)}`)
  );
}
