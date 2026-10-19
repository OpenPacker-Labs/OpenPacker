/**
 * Typed access to the plain tree `readYamlTree` returns. Each function checks
 * one thing about a value and names it, by path, when it is not so; nothing
 * here knows what a lock is.
 */

import { PnpmLockError, at, field } from './errors.js';
import { compareKeys } from './order.js';
import { checkLimit, type PnpmLockLimits } from './limits.js';
import { packageNameProblem } from './source.js';
import type { YamlMap, YamlValue } from './yaml-tree.js';

export interface ReadContext {
  readonly limits: PnpmLockLimits;
}

function describe(value: YamlValue | undefined): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'empty';
  if (value instanceof Map) return 'a mapping';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  return 'a boolean';
}

function wrong(where: string, wanted: string, value: YamlValue | undefined) {
  return new PnpmLockError(
    'shape',
    `must be ${wanted}, but is ${describe(value)}`,
    where,
  );
}

export function asMap(value: YamlValue | undefined, where: string): YamlMap {
  if (!(value instanceof Map)) throw wrong(where, 'a mapping', value);
  return value;
}

export function asString(value: YamlValue | undefined, where: string): string {
  if (typeof value !== 'string')
    throw wrong(
      where,
      'a string (quote it if it looks like a number or a boolean)',
      value,
    );
  return value;
}

/** The string under `key`, or undefined when the key is absent. */
export function optionalString(
  record: YamlMap,
  key: string,
  where: string,
): string | undefined {
  const value = record.get(key);
  return value === undefined ? undefined : asString(value, field(where, key));
}

export function asBoolean(
  value: YamlValue | undefined,
  where: string,
): boolean {
  if (typeof value !== 'boolean') throw wrong(where, 'true or false', value);
  return value;
}

export function asCount(value: YamlValue | undefined, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw wrong(where, 'a positive whole number', value);
  return value;
}

export function asList(
  value: YamlValue | undefined,
  where: string,
): readonly YamlValue[] {
  if (!Array.isArray(value)) throw wrong(where, 'a list', value);
  return value;
}

/** A list of non-empty strings, at most `maxEntries` long, in the order written. */
export function asStringList(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): readonly string[] {
  const list = asList(value, where);
  checkLimit(
    list.length,
    ctx.limits.maxEntries,
    'entries in a list',
    'maxEntries',
    where,
  );
  return list.map((item, index) => {
    const text = asString(item, `${where}[${index}]`);
    if (text === '')
      throw new PnpmLockError(
        'shape',
        'must not hold an empty string',
        `${where}[${index}]`,
      );
    return text;
  });
}

/** A mapping of string to string, as a `Map` sorted by key. */
export function asStringMap(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): ReadonlyMap<string, string> {
  const map = asMap(value, where);
  checkLimit(
    map.size,
    ctx.limits.maxEntries,
    'entries in a mapping',
    'maxEntries',
    where,
  );
  const out = new Map<string, string>();
  for (const key of [...map.keys()].sort(compareKeys))
    out.set(key, asString(map.get(key), at(where, key)));
  return out;
}

/** Refuse a key pnpm 9 and 10 do not write in this place (pnpm 11 adds two: see ADR 0052). */
export function rejectUnknown(
  map: YamlMap,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of map.keys())
    if (!allowed.includes(key))
      throw new PnpmLockError(
        'unknown-key',
        `has the key ${JSON.stringify(key)}, which pnpm 9 and 10 do not write here (they write ${allowed.join(', ')})`,
        where,
      );
}

/** The entries of a mapping in key order. */
export function sortedEntries(map: YamlMap): [string, YamlValue][] {
  return [...map.entries()].sort(([a], [b]) => compareKeys(a, b));
}

/** A package name that can be a directory under `node_modules`, or a refusal. */
export function checkedName(name: string, where: string): string {
  const problem = packageNameProblem(name);
  if (problem !== undefined) throw new PnpmLockError('name', problem, where);
  return name;
}

export { at, field };
