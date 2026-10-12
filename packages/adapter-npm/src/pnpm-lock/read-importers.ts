/**
 * `importers`: the workspace's projects and the direct dependencies of each.
 *
 * ```yaml
 * importers:
 *   packages/app:
 *     dependencies:
 *       '@scope/lib':
 *         specifier: workspace:*
 *         version: link:../lib
 *       react:
 *         specifier: ^18.2.0
 *         version: 18.2.0
 * ```
 */

import { PnpmLockError } from './errors.js';
import { checkLimit } from './limits.js';
import { parseRef } from './ref.js';
import {
  asBoolean,
  asMap,
  asString,
  at,
  checkedName,
  field,
  rejectUnknown,
  sortedEntries,
  type ReadContext,
} from './read-support.js';
import { insidePathProblem } from './source.js';
import type {
  PnpmDependencyMeta,
  PnpmImporter,
  PnpmImporterDependency,
} from './types.js';
import type { YamlValue } from './yaml-tree.js';

const FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

function readDependencies(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): PnpmImporterDependency[] {
  if (value === undefined) return [];
  const map = asMap(value, where);
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'dependencies',
    'maxEntries',
    where,
  );
  return sortedEntries(map).map(([name, entry]) => {
    const here = at(where, name);
    checkedName(name, here);
    const record = asMap(entry, here);
    rejectUnknown(record, ['specifier', 'version'], here);
    const specifier = asString(
      record.get('specifier'),
      field(here, 'specifier'),
    );
    const raw = asString(record.get('version'), field(here, 'version'));
    return {
      name,
      specifier,
      ref: parseRef(name, raw, ctx.limits, field(here, 'version')),
    };
  });
}

function readMeta(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): ReadonlyMap<string, PnpmDependencyMeta> {
  const out = new Map<string, PnpmDependencyMeta>();
  if (value === undefined) return out;
  const map = asMap(value, where);
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'dependenciesMeta entries',
    'maxEntries',
    where,
  );
  for (const [name, entry] of sortedEntries(map)) {
    const here = at(where, name);
    checkedName(name, here);
    const record = asMap(entry, here);
    rejectUnknown(record, ['injected', 'node', 'patch'], here);
    const injected = record.get('injected');
    const node = record.get('node');
    const patch = record.get('patch');
    out.set(name, {
      ...(injected !== undefined && {
        injected: asBoolean(injected, field(here, 'injected')),
      }),
      ...(node !== undefined && { node: asString(node, field(here, 'node')) }),
      ...(patch !== undefined && {
        patch: asString(patch, field(here, 'patch')),
      }),
    });
  }
  return out;
}

/** An importer id is a project directory: `.` or a normalized path inside the workspace, not under node_modules. */
function checkedImporterId(id: string, where: string): string {
  const problem = insidePathProblem(id, true);
  if (problem !== undefined)
    throw new PnpmLockError('unsafe-path', `importer id ${problem}`, where);
  if (id.split('/').includes('node_modules'))
    throw new PnpmLockError(
      'unsafe-path',
      'importer id is inside a node_modules directory',
      where,
    );
  return id;
}

export function readImporters(
  value: YamlValue | undefined,
  ctx: ReadContext,
): PnpmImporter[] {
  if (value === undefined) return [];
  const map = asMap(value, 'importers');
  checkLimit(
    map.size,
    ctx.limits.maxImporters,
    'importers',
    'maxImporters',
    'importers',
  );
  return sortedEntries(map).map(([id, entry]) => {
    const where = at('importers', id);
    checkedImporterId(id, where);
    const record = asMap(entry, where);
    rejectUnknown(
      record,
      [...FIELDS, 'dependenciesMeta', 'publishDirectory'],
      where,
    );
    const publish = record.get('publishDirectory');
    let publishDirectory: string | undefined;
    if (publish !== undefined) {
      publishDirectory = asString(publish, field(where, 'publishDirectory'));
      const problem = insidePathProblem(publishDirectory, false);
      if (problem !== undefined)
        throw new PnpmLockError(
          'unsafe-path',
          `publish directory ${problem}`,
          field(where, 'publishDirectory'),
        );
    }
    return {
      id,
      dependencies: readDependencies(
        record.get('dependencies'),
        field(where, 'dependencies'),
        ctx,
      ),
      devDependencies: readDependencies(
        record.get('devDependencies'),
        field(where, 'devDependencies'),
        ctx,
      ),
      optionalDependencies: readDependencies(
        record.get('optionalDependencies'),
        field(where, 'optionalDependencies'),
        ctx,
      ),
      dependenciesMeta: readMeta(
        record.get('dependenciesMeta'),
        field(where, 'dependenciesMeta'),
        ctx,
      ),
      ...(publishDirectory !== undefined && { publishDirectory }),
    };
  });
}
