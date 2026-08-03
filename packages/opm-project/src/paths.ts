import { dirname, join, resolve, sep } from 'node:path';
import { OpmError } from './types.js';

export const MANIFEST_NAME = 'opm.toml';
export const LOCK_NAME = 'opm.lock.json';
export const OPM_DIR = '.opm';
export const STORE_DIR = 'store';
export const BIN_DIR = 'bin';
export const LINKS_DIR = 'links';
export const PROJECT_STATE = 'project.json';
export const CATALOG_NAME = 'catalog.json';

/** Single path segment safe for aliases, bin names, link files. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const STORE_KEY = /^sha256-[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ProjectPaths {
  root: string;
  manifest: string;
  lock: string;
  opmDir: string;
  store: string;
  bin: string;
  links: string;
  projectState: string;
  catalog: string;
}

export function projectPaths(root: string): ProjectPaths {
  const resolved = resolve(root);
  const opmDir = join(resolved, OPM_DIR);
  return {
    root: resolved,
    manifest: join(resolved, MANIFEST_NAME),
    lock: join(resolved, LOCK_NAME),
    opmDir,
    store: join(opmDir, STORE_DIR),
    bin: join(opmDir, BIN_DIR),
    links: join(opmDir, LINKS_DIR),
    projectState: join(opmDir, PROJECT_STATE),
    catalog: join(opmDir, CATALOG_NAME),
  };
}

export function assertSafeSegment(value: string, kind: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid ${kind} "${value}" (must match ${SAFE_SEGMENT})`,
    );
  }
  return value;
}

export function assertDigest(digest: string): string {
  if (!DIGEST.test(digest)) {
    throw new OpmError(
      'INVALID_DIGEST',
      `Invalid digest "${digest}" (expected sha256:<64 hex>)`,
    );
  }
  return digest;
}

export function storeKeyFromDigest(digest: string): string {
  const normalized = assertDigest(digest);
  const value = normalized.slice('sha256:'.length);
  return `sha256-${value}`;
}

export function assertStoreKey(storeKey: string, digest?: string): string {
  if (!STORE_KEY.test(storeKey)) {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid storeKey "${storeKey}" (expected sha256-<64 hex>)`,
    );
  }
  if (digest !== undefined) {
    const expected = storeKeyFromDigest(digest);
    if (storeKey !== expected) {
      throw new OpmError(
        'UNSAFE_PATH',
        `storeKey "${storeKey}" does not match digest ${digest}`,
      );
    }
  }
  return storeKey;
}

/** Resolve a path under root; reject escapes. */
export function resolveContained(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new OpmError(
      'UNSAFE_PATH',
      `Path escapes containment root: ${parts.join('/')}`,
    );
  }
  return target;
}

export function storePathForDigest(root: string, digest: string): string {
  return resolveContained(projectPaths(root).store, storeKeyFromDigest(digest));
}

export function findProjectRoot(
  start: string,
  stopAt: string = dirname(resolve(start)),
): string | undefined {
  let current = resolve(start);
  const stop = resolve(stopAt);
  for (;;) {
    const paths = projectPaths(current);
    try {
      // sync check via path only — caller uses exists
      if (current === stop && current !== resolve(start)) break;
    } catch {
      // ignore
    }
    // Use filesystem via require would be async; expose path candidate only
    void paths;
    if (current === dirname(current)) break;
    // walk handled by async helper in project.ts
    break;
  }
  return undefined;
}

export function parentDirs(start: string): string[] {
  const result: string[] = [];
  let current = resolve(start);
  for (;;) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}
