/**
 * `snapshots`: a package as installed against one set of peers. The key is a
 * dependency path (`name@version(peers)`); the entry is the edges out of it.
 *
 * ```yaml
 * snapshots:
 *   react-dom@18.2.0(react@18.2.0):
 *     dependencies:
 *       loose-envify: 1.4.0
 *       react: 18.2.0
 *   fsevents@2.3.3:
 *     optional: true
 *   no-deps@1.0.0: {}
 * ```
 */

import { parseDepPath } from './dep-path.js';
import { checkLimit } from './limits.js';
import { parseRef } from './ref.js';
import {
  asBoolean,
  asMap,
  asString,
  asStringList,
  at,
  checkedName,
  field,
  rejectUnknown,
  sortedEntries,
  type ReadContext,
} from './read-support.js';
import type { PnpmSnapshot, PnpmSnapshotDependency } from './types.js';
import type { YamlValue } from './yaml-tree.js';

function readEdges(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): PnpmSnapshotDependency[] {
  if (value === undefined) return [];
  const map = asMap(value, where);
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'dependencies',
    'maxEntries',
    where,
  );
  return sortedEntries(map).map(([name, raw]) => {
    const here = at(where, name);
    checkedName(name, here);
    return { name, ref: parseRef(name, asString(raw, here), ctx.limits, here) };
  });
}

function readSnapshot(
  key: string,
  entry: YamlValue,
  ctx: ReadContext,
): PnpmSnapshot {
  const where = at('snapshots', key);
  const path = parseDepPath(key, ctx.limits, where);
  const record = asMap(entry, where);
  rejectUnknown(
    record,
    [
      'dependencies',
      'optionalDependencies',
      'transitivePeerDependencies',
      'optional',
      'id',
      'patched',
    ],
    where,
  );
  const transitive = record.get('transitivePeerDependencies');
  const optional = record.get('optional');
  const id = record.get('id');
  const patched = record.get('patched');
  return {
    key,
    path,
    dependencies: readEdges(
      record.get('dependencies'),
      field(where, 'dependencies'),
      ctx,
    ),
    optionalDependencies: readEdges(
      record.get('optionalDependencies'),
      field(where, 'optionalDependencies'),
      ctx,
    ),
    transitivePeerDependencies:
      transitive === undefined
        ? []
        : asStringList(
            transitive,
            field(where, 'transitivePeerDependencies'),
            ctx,
          ),
    optional:
      optional === undefined
        ? false
        : asBoolean(optional, field(where, 'optional')),
    ...(id !== undefined && { id: asString(id, field(where, 'id')) }),
    ...(patched !== undefined && {
      patched: asBoolean(patched, field(where, 'patched')),
    }),
  };
}

export function readSnapshots(
  value: YamlValue | undefined,
  ctx: ReadContext,
): PnpmSnapshot[] {
  if (value === undefined) return [];
  const map = asMap(value, 'snapshots');
  checkLimit(
    map.size,
    ctx.limits.maxSnapshots,
    'snapshots',
    'maxSnapshots',
    'snapshots',
  );
  return sortedEntries(map).map(([key, entry]) =>
    readSnapshot(key, entry, ctx),
  );
}
