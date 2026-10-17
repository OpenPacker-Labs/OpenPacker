/**
 * The small sections at the top of a lock: `settings`, `overrides`,
 * `catalogs`, `patchedDependencies` and the checksums. None of them is a
 * package; each says how the install that wrote the lock was configured.
 */

import { PnpmLockError } from './errors.js';
import { checkLimit } from './limits.js';
import { parseRef } from './ref.js';
import {
  asBoolean,
  asCount,
  asMap,
  asString,
  asStringMap,
  at,
  checkedName,
  field,
  rejectUnknown,
  sortedEntries,
  type ReadContext,
} from './read-support.js';
import { insidePathProblem } from './source.js';
import { patchedPackageName } from './specifier.js';
import type { PnpmCatalogEntry, PnpmPatch, PnpmSettings } from './types.js';
import type { YamlValue } from './yaml-tree.js';

export function readSettings(value: YamlValue | undefined): PnpmSettings {
  if (value === undefined) return {};
  const where = 'settings';
  const record = asMap(value, where);
  rejectUnknown(
    record,
    [
      'autoInstallPeers',
      'excludeLinksFromLockfile',
      'peersSuffixMaxLength',
      'injectWorkspacePackages',
    ],
    where,
  );
  const auto = record.get('autoInstallPeers');
  const exclude = record.get('excludeLinksFromLockfile');
  const suffix = record.get('peersSuffixMaxLength');
  const inject = record.get('injectWorkspacePackages');
  return {
    ...(auto !== undefined && {
      autoInstallPeers: asBoolean(auto, field(where, 'autoInstallPeers')),
    }),
    ...(exclude !== undefined && {
      excludeLinksFromLockfile: asBoolean(
        exclude,
        field(where, 'excludeLinksFromLockfile'),
      ),
    }),
    ...(suffix !== undefined && {
      peersSuffixMaxLength: asCount(
        suffix,
        field(where, 'peersSuffixMaxLength'),
      ),
    }),
    ...(inject !== undefined && {
      injectWorkspacePackages: asBoolean(
        inject,
        field(where, 'injectWorkspacePackages'),
      ),
    }),
  };
}

export function readOverrides(
  value: YamlValue | undefined,
  ctx: ReadContext,
): ReadonlyMap<string, string> {
  return value === undefined ? new Map() : asStringMap(value, 'overrides', ctx);
}

export function readTime(
  value: YamlValue | undefined,
  ctx: ReadContext,
): ReadonlyMap<string, string> {
  return value === undefined ? new Map() : asStringMap(value, 'time', ctx);
}

/** `catalogs.<catalog>.<dependency>: {specifier, version}`. */
export function readCatalogs(
  value: YamlValue | undefined,
  ctx: ReadContext,
): ReadonlyMap<string, ReadonlyMap<string, PnpmCatalogEntry>> {
  const out = new Map<string, ReadonlyMap<string, PnpmCatalogEntry>>();
  if (value === undefined) return out;
  const catalogs = asMap(value, 'catalogs');
  checkLimit(
    catalogs.size,
    ctx.limits.maxEntries,
    'catalogs',
    'maxEntries',
    'catalogs',
  );
  for (const [catalogName, catalog] of sortedEntries(catalogs)) {
    const where = at('catalogs', catalogName);
    const entries = asMap(catalog, where);
    checkLimit(
      entries.size,
      ctx.limits.maxEntries,
      'catalog entries',
      'maxEntries',
      where,
    );
    const resolved = new Map<string, PnpmCatalogEntry>();
    for (const [name, entry] of sortedEntries(entries)) {
      const here = at(where, name);
      checkedName(name, here);
      const record = asMap(entry, here);
      rejectUnknown(record, ['specifier', 'version'], here);
      resolved.set(name, {
        specifier: asString(record.get('specifier'), field(here, 'specifier')),
        ref: parseRef(
          name,
          asString(record.get('version'), field(here, 'version')),
          ctx.limits,
          here,
        ),
      });
    }
    out.set(catalogName, resolved);
  }
  return out;
}

/** `patchedDependencies.<name@version>: {hash, path}`. */
export function readPatchedDependencies(
  value: YamlValue | undefined,
  ctx: ReadContext,
): ReadonlyMap<string, PnpmPatch> {
  const out = new Map<string, PnpmPatch>();
  if (value === undefined) return out;
  const map = asMap(value, 'patchedDependencies');
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'patched dependencies',
    'maxEntries',
    'patchedDependencies',
  );
  for (const [key, entry] of sortedEntries(map)) {
    const where = at('patchedDependencies', key);
    checkedName(patchedPackageName(key), where);
    checkLimit(
      key.length,
      ctx.limits.maxKeyLength,
      'characters in a key',
      'maxKeyLength',
      where,
    );
    const record = asMap(entry, where);
    rejectUnknown(record, ['hash', 'path'], where);
    const hash = asString(record.get('hash'), field(where, 'hash'));
    if (!/^[a-z0-9]{1,128}$/u.test(hash))
      throw new PnpmLockError(
        'shape',
        'must be a lower case alphanumeric hash',
        field(where, 'hash'),
      );
    const file = asString(record.get('path'), field(where, 'path'));
    const problem = insidePathProblem(file, false);
    if (problem !== undefined)
      throw new PnpmLockError(
        'unsafe-path',
        `patch file ${problem}`,
        field(where, 'path'),
      );
    out.set(key, { hash, path: file });
  }
  return out;
}

/** `packageExtensionsChecksum` and `pnpmfileChecksum`: an opaque digest string. */
export function readChecksum(
  value: YamlValue | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const text = asString(value, name);
  if (!/^[A-Za-z0-9+/=_:.-]{1,256}$/u.test(text))
    throw new PnpmLockError(
      'shape',
      'must be a digest (letters, digits and + / = _ : . -)',
      name,
    );
  return text;
}
