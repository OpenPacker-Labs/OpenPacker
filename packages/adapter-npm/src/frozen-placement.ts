/**
 * Whether the places a frozen install would write can be written.
 *
 * A lock's places are its keys, so everything the layout refuses about them
 * (an unsafe name, two packages claiming one place, a package inside a parent
 * that is not installed, two names that differ only by case in one directory,
 * a member link in the way) is known from the lock alone. Asked when the lock
 * is read, the answer comes before a byte is fetched and before the project's
 * `node_modules` is removed; the layout asks again of what it writes.
 */

import type { FrozenLockPackage } from '@openpacker/adapter-core';
import type { FrozenInstallPlan } from './frozen-select.js';
import { checkLockPlacements, type PlaceToCheck } from './layout-lock-plan.js';
import { placeOfLockPath } from './lock-entry.js';

/** Throws what the layout would throw about the places of `plan`'s packages. */
export function assertPlaceable(plan: FrozenInstallPlan): void {
  // A lock with entries that cannot be installed is refused whole by the host
  // before anything is written, and says so itself.
  if (plan.refused.length > 0) return;
  const placed = plan.packages.flatMap((pkg): PlaceToCheck[] => {
    const where = placeOfLockPath(pkg.path);
    return where === undefined ? [] : [placeToCheck(pkg, where)];
  });
  checkLockPlacements(placed, {
    members: plan.workspace?.layout.members.map((member) => member.dir) ?? [],
    links: plan.workspace?.layout.links ?? [],
  });
}

function placeToCheck(
  pkg: FrozenLockPackage,
  where: { chain: string[]; base?: string },
): PlaceToCheck {
  return {
    id: pkg.path,
    name: pkg.packageName,
    version: pkg.version,
    ...where,
  };
}
