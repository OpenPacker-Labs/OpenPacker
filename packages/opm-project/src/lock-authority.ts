import { canonicalize } from '@openpacker/canonical';
import type { LockPackage } from './types.js';
import { OpmError } from './types.js';

const LOCK_PACKAGE_FIELDS = new Set([
  'alias',
  'purl',
  'version',
  'digest',
  'size',
  'format',
  'mediaType',
  'source',
  'storeKey',
  'bins',
  'reason',
  'ecosystem',
  'dependencies',
  'trustLevel',
  'publishedAt',
  'registryId',
  'sourceKind',
  'lifecycle',
  'nativeIntegrity',
]);

export function lockPackageBinding(pkg: LockPackage): string {
  if (!isPlainObject(pkg))
    throw new OpmError('INVALID_LOCK', 'Lock package must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(pkg);
  if (Object.getOwnPropertySymbols(pkg).length > 0)
    throw new OpmError('INVALID_LOCK', 'Lock package has symbol fields');
  for (const [key, descriptor] of Object.entries(descriptors))
    if (!LOCK_PACKAGE_FIELDS.has(key) || !('value' in descriptor))
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package has unsafe field ${key}`,
      );
  const projected: Record<string, unknown> = {};
  for (const key of LOCK_PACKAGE_FIELDS) {
    const descriptor = descriptors[key];
    if (
      descriptor !== undefined &&
      'value' in descriptor &&
      descriptor.value !== undefined
    )
      projected[key] = clonePlainData(descriptor.value, key, new WeakSet());
  }
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalize(projected as never);
}

export function assertPlainLockPackageData(pkg: LockPackage): void {
  lockPackageBinding(pkg);
}

export function freezeBoundLockPackage(pkg: LockPackage): string {
  const binding = lockPackageBinding(pkg);
  deepFreeze(pkg);
  return binding;
}

export function immutablePlainData<T>(value: T, label: string): T {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const cloned = clonePlainData(value, label, new WeakSet()) as T;
  deepFreeze(cloned);
  return cloned;
}

function clonePlainData(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value))
      throw new OpmError('INVALID_LOCK', `Lock package ${path} is cyclic`);
    seen.add(value);
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      clonePlainData(item, `${path}[${index}]`, seen),
    );
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
    throw new OpmError(
      'INVALID_LOCK',
      `Lock package ${path} is not plain data`,
    );
  const cloned: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!('value' in descriptor))
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${path}.${key} is an accessor`,
      );
    if (descriptor.value !== undefined)
      cloned[key] = clonePlainData(descriptor.value, `${path}.${key}`, seen);
  }
  return cloned;
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  ))
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  if (!Object.isFrozen(value)) Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
