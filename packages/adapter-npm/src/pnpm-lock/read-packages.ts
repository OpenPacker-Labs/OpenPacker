/**
 * `packages`: one entry per `name@version` the lock installs, whatever peers it
 * was resolved against (those are `snapshots`).
 *
 * ```yaml
 * packages:
 *   '@esbuild/linux-x64@0.25.4':
 *     resolution: {integrity: sha512-...}
 *     engines: {node: '>=18'}
 *     cpu: [x64]
 *     os: [linux]
 * ```
 */

import { PnpmLockError } from './errors.js';
import { parseDepPath } from './dep-path.js';
import { checkLimit } from './limits.js';
import { readResolution } from './read-resolution.js';
import {
  asBoolean,
  asList,
  asMap,
  asStringList,
  asStringMap,
  at,
  checkedName,
  optionalString,
  field,
  rejectUnknown,
  sortedEntries,
  type ReadContext,
} from './read-support.js';
import { isSemver } from './source.js';
import type { PnpmPackage } from './types.js';
import type { YamlValue } from './yaml-tree.js';

const KEYS = [
  'resolution',
  'name',
  'version',
  'engines',
  'cpu',
  'os',
  'libc',
  'hasBin',
  'deprecated',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
] as const;

function readPeerMeta(
  value: YamlValue,
  where: string,
  ctx: ReadContext,
): ReadonlyMap<string, { readonly optional: boolean }> {
  const map = asMap(value, where);
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'peerDependenciesMeta entries',
    'maxEntries',
    where,
  );
  const out = new Map<string, { readonly optional: boolean }>();
  for (const [name, entry] of sortedEntries(map)) {
    const here = at(where, name);
    const record = asMap(entry, here);
    rejectUnknown(record, ['optional'], here);
    const optional = record.get('optional');
    out.set(name, {
      optional:
        optional === undefined
          ? false
          : asBoolean(optional, field(here, 'optional')),
    });
  }
  return out;
}

function readBundled(
  value: YamlValue,
  where: string,
  ctx: ReadContext,
): boolean | readonly string[] {
  if (typeof value === 'boolean') return value;
  asList(value, where);
  return asStringList(value, where, ctx);
}

function readPackage(
  key: string,
  entry: YamlValue,
  ctx: ReadContext,
): PnpmPackage {
  const where = at('packages', key);
  const path = parseDepPath(key, ctx.limits, where);
  if (
    path.peers.length > 0 ||
    path.patchHash !== undefined ||
    path.peersHash !== undefined
  )
    throw new PnpmLockError(
      'dep-path',
      'is a snapshot key; a package is name@version with no peer suffix',
      where,
    );
  const record = asMap(entry, where);
  rejectUnknown(record, KEYS, where);
  const manifestName = optionalString(record, 'name', where);
  if (manifestName !== undefined)
    checkedName(manifestName, field(where, 'name'));
  const manifestVersion = optionalString(record, 'version', where);
  if (manifestVersion !== undefined && !isSemver(manifestVersion))
    throw new PnpmLockError(
      'shape',
      `must be a semantic version, not ${JSON.stringify(manifestVersion)}`,
      field(where, 'version'),
    );
  const cpu = record.get('cpu');
  const os = record.get('os');
  const libc = record.get('libc');
  const hasBin = record.get('hasBin');
  const bundled = record.get('bundledDependencies');
  const peerMeta = record.get('peerDependenciesMeta');
  const engines = record.get('engines');
  const peers = record.get('peerDependencies');
  const deprecated = optionalString(record, 'deprecated', where);
  return {
    key,
    name: path.name,
    version: path.version,
    source: path.source,
    resolution: readResolution(
      record.get('resolution'),
      field(where, 'resolution'),
      ctx,
    ),
    ...(manifestName !== undefined && { manifestName }),
    ...(manifestVersion !== undefined && { manifestVersion }),
    engines:
      engines === undefined
        ? new Map()
        : asStringMap(engines, field(where, 'engines'), ctx),
    ...(cpu !== undefined && {
      cpu: asStringList(cpu, field(where, 'cpu'), ctx),
    }),
    ...(os !== undefined && { os: asStringList(os, field(where, 'os'), ctx) }),
    ...(libc !== undefined && {
      libc: asStringList(libc, field(where, 'libc'), ctx),
    }),
    hasBin:
      hasBin === undefined ? false : asBoolean(hasBin, field(where, 'hasBin')),
    ...(deprecated !== undefined && { deprecated }),
    peerDependencies:
      peers === undefined
        ? new Map()
        : asStringMap(peers, field(where, 'peerDependencies'), ctx),
    peerDependenciesMeta:
      peerMeta === undefined
        ? new Map()
        : readPeerMeta(peerMeta, field(where, 'peerDependenciesMeta'), ctx),
    ...(bundled !== undefined && {
      bundledDependencies: readBundled(
        bundled,
        field(where, 'bundledDependencies'),
        ctx,
      ),
    }),
  };
}

export function readPackages(
  value: YamlValue | undefined,
  ctx: ReadContext,
): PnpmPackage[] {
  if (value === undefined) return [];
  const map = asMap(value, 'packages');
  checkLimit(
    map.size,
    ctx.limits.maxPackages,
    'packages',
    'maxPackages',
    'packages',
  );
  return sortedEntries(map).map(([key, entry]) => readPackage(key, entry, ctx));
}
