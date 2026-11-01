/**
 * Which packages' install scripts a project approved.
 *
 * npm has no such declaration (it runs every script, or none with
 * `ignore-scripts`). The package managers that run none by default read an
 * allowlist, and a project declares it for them: pnpm's `onlyBuiltDependencies`
 * (in `package.json`'s `pnpm` field or `pnpm-workspace.yaml`) and `allowBuilds`
 * (`pnpm-workspace.yaml`, a name to `true`), and Bun's `trustedDependencies`
 * (`package.json`). An entry is a package name, or `name@version`.
 */

import type { FrozenLock } from '@openpacker/adapter-core';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item !== '',
      )
    : [];

/** The approvals `manifest` (the root `package.json`) and `workspace` (`pnpm-workspace.yaml`) declare. */
export function approvedBuildsOf(
  manifest: Json,
  workspace: Json = {},
): FrozenLock['approvedBuilds'] {
  const entries = new Set<string>();
  const declaredIn: string[] = [];
  const take = (found: readonly string[], where: string) => {
    if (found.length === 0) return;
    for (const entry of found) entries.add(entry);
    declaredIn.push(where);
  };
  take(
    names(manifest['trustedDependencies']),
    'package.json trustedDependencies',
  );
  const pnpm = isRecord(manifest['pnpm']) ? manifest['pnpm'] : {};
  take(
    names(pnpm['onlyBuiltDependencies']),
    'package.json pnpm.onlyBuiltDependencies',
  );
  take(
    names(workspace['onlyBuiltDependencies']),
    'pnpm-workspace.yaml onlyBuiltDependencies',
  );
  const allow = workspace['allowBuilds'];
  if (isRecord(allow))
    take(
      Object.entries(allow)
        .filter(([, value]) => value === true)
        .map(([key]) => key),
      'pnpm-workspace.yaml allowBuilds',
    );
  return entries.size === 0
    ? undefined
    : { entries: [...entries].sort(), declaredIn };
}
