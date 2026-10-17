/**
 * Which patch of a pnpm lock's `patchedDependencies` each instance takes
 * (ADR 0056), as pnpm 10.28 decides it, and what in the lock is refused.
 *
 * pnpm groups the declarations by package name (`groupPatchedDependencies` in
 * `@pnpm/patching.config`): `name@1.2.3` is that exact version, `name@^1` a
 * range (a key that is neither a version nor a range is
 * `ERR_PNPM_PATCH_NON_SEMVER_RANGE`), `name@*` every version, and a bare
 * `name` every version too. A package takes the exact one, else the one range
 * it satisfies (two are `ERR_PNPM_PATCH_KEY_CONFLICT`), else the one for every
 * version (`getPatchInfo`). pnpm 9 knew only the exact and bare forms, which
 * mean the same here.
 *
 * pnpm decides from the project's settings, which a fresh lock records as they
 * are; a frozen install of the lock decides from the lock and holds the
 * snapshots to it: an instance a patch applies to must carry that patch's
 * hash in its key (`(patch_hash=...)`), and one that carries a hash must have
 * a patch that applies. A declaration that applies to no package the lock
 * holds is refused, as pnpm refuses it when it resolves (`ERR_PNPM_UNUSED_PATCH`).
 */

import type { FrozenLockRefusal } from '@openpacker/adapter-core';
import type { PnpmLock, PnpmPatch } from '../pnpm-lock/types.js';
import { patchHashForm } from '../pnpm-patch/index.js';
import type { PnpmModel } from './model.js';
import { quote } from './quote.js';
import { isRange, versionSatisfies } from './ranges.js';

interface Declaration extends PnpmPatch {
  readonly key: string;
}

interface Group {
  readonly exact: Map<string, Declaration>;
  readonly range: { readonly version: string; readonly patch: Declaration }[];
  all?: Declaration;
}

/** node-semver's `valid`: a whole version, an optional leading `v`, surrounding space allowed. */
const VALID =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** `groupPatchedDependencies`, with the keys it refuses as refusals. */
function groupPatches(
  declared: ReadonlyMap<string, PnpmPatch>,
  refused: FrozenLockRefusal[],
  unreadable: Set<string>,
): Map<string, Group> {
  const groups = new Map<string, Group>();
  const group = (name: string): Group => {
    let found = groups.get(name);
    if (found === undefined) {
      found = { exact: new Map(), range: [] };
      groups.set(name, found);
    }
    return found;
  };
  for (const [key, patch] of declared) {
    const declaration = { ...patch, key };
    const at = key.indexOf('@', 1);
    const version = at === -1 ? '' : key.slice(at + 1);
    if (version === '') {
      group(key).all = declaration;
      continue;
    }
    const name = key.slice(0, at);
    if (VALID.test(version.trim())) group(name).exact.set(version, declaration);
    else if (!isRange(version)) {
      unreadable.add(key);
      refused.push({
        path: `patchedDependencies[${quote(key)}]`,
        reason: `${quote(version)} is not a version or a range, as pnpm refuses it (ERR_PNPM_PATCH_NON_SEMVER_RANGE)`,
      });
    } else if (version.trim() === '*') group(name).all = declaration;
    else group(name).range.push({ version, patch: declaration });
  }
  return groups;
}

/** `getPatchInfo`: the declaration `name@version` takes, or why none can be chosen. */
function patchFor(
  groups: ReadonlyMap<string, Group>,
  name: string,
  version: string,
): Declaration | { readonly conflict: readonly string[] } | undefined {
  const group = groups.get(name);
  if (group === undefined) return undefined;
  const exact = group.exact.get(version);
  if (exact !== undefined) return exact;
  const satisfied = group.range.filter((item) =>
    versionSatisfies(version, item.version),
  );
  if (satisfied.length > 1)
    return { conflict: satisfied.map((item) => item.patch.key) };
  return satisfied[0]?.patch ?? group.all;
}

/** The patch each instance of the lock takes, by snapshot key, and what is refused. */
export interface LockPatches {
  readonly byInstance: ReadonlyMap<string, string>;
  readonly refused: readonly FrozenLockRefusal[];
}

/** What the lock's patches say, checked against its snapshots. */
export function lockPatches(model: PnpmModel): LockPatches {
  const lock: PnpmLock = model.lock;
  const refused: FrozenLockRefusal[] = [];
  const byInstance = new Map<string, string>();
  if (lock.patchedDependencies.size === 0) return { byInstance, refused };
  for (const [key, patch] of lock.patchedDependencies)
    if (patchHashForm(patch.hash) === undefined)
      refused.push({
        path: `patchedDependencies[${quote(key)}].hash`,
        reason: `is ${quote(patch.hash)}, which is neither pnpm 10's hash of a patch (64 hex digits) nor pnpm 9's (26 base32 characters), so opm cannot check the file against it`,
      });
  // A key pnpm cannot read is refused once, not again as unused.
  const unreadable = new Set<string>();
  const groups = groupPatches(lock.patchedDependencies, refused, unreadable);
  const carried = new Map(
    lock.snapshots.map((snapshot) => [snapshot.key, snapshot.path.patchHash]),
  );
  const used = new Set<string>();
  for (const instance of model.instances.values()) {
    const where = `snapshots[${quote(instance.key)}]`;
    const hash = carried.get(instance.key);
    const chosen = patchFor(groups, instance.name, instance.version);
    if (chosen !== undefined && 'conflict' in chosen) {
      refused.push({
        path: where,
        reason: `satisfies the ranges of ${chosen.conflict.map(quote).join(', ')}, and pnpm cannot choose between them (ERR_PNPM_PATCH_KEY_CONFLICT)`,
      });
      continue;
    }
    if (chosen === undefined) {
      if (hash !== undefined)
        refused.push({
          path: where,
          reason: `carries patch_hash ${quote(hash)}, and no patch in patchedDependencies applies to ${quote(`${instance.name}@${instance.version}`)}`,
        });
      continue;
    }
    used.add(chosen.key);
    if (hash !== chosen.hash)
      refused.push({
        path: where,
        reason:
          hash === undefined
            ? `carries no patch_hash, although patchedDependencies[${quote(chosen.key)}] applies to it`
            : `carries patch_hash ${quote(hash)}, and patchedDependencies[${quote(chosen.key)}], which applies to it, records ${quote(chosen.hash)}`,
      });
    else byInstance.set(instance.key, chosen.key);
  }
  for (const key of lock.patchedDependencies.keys())
    if (!used.has(key) && !unreadable.has(key))
      refused.push({
        path: `patchedDependencies[${quote(key)}]`,
        reason:
          'applies to no package pnpm-lock.yaml holds, as pnpm refuses an unused patch when it resolves (ERR_PNPM_UNUSED_PATCH)',
      });
  return { byInstance, refused };
}
