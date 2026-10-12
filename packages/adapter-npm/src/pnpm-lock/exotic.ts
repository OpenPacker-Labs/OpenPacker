/**
 * The packages whose bytes do not come from the registry by name and version.
 * A policy decides whether each is allowed (ADR 0046 §4 names the source kinds
 * it can block); this only says which they are and what each one points at.
 */

import { compareKeys } from './order.js';
import type { PnpmLock } from './types.js';

export type PnpmExoticSource =
  /** An archive at a URL: a git host's tarball, a plain `https://` archive, a registry with its own layout, a `file:` archive. */
  | {
      readonly kind: 'tarball';
      readonly key: string;
      readonly name: string;
      readonly version: string;
      readonly url: string;
      readonly integrity?: string;
    }
  /** A git repository at a commit. */
  | {
      readonly kind: 'git';
      readonly key: string;
      readonly name: string;
      readonly version: string;
      readonly repo: string;
      readonly commit: string;
      readonly path?: string;
    }
  /** A directory on disk. */
  | {
      readonly kind: 'directory';
      readonly key: string;
      readonly name: string;
      readonly version: string;
      readonly directory: string;
    }
  /** A runtime (`node@runtime:`) with an archive per platform. */
  | {
      readonly kind: 'runtime';
      readonly key: string;
      readonly name: string;
      readonly version: string;
      readonly variants: number;
    };

/** Every package in the lock whose resolution is not a bare registry integrity, in key order. */
export function exoticSourcesOf(lock: PnpmLock): PnpmExoticSource[] {
  const out: PnpmExoticSource[] = [];
  for (const pkg of lock.packages) {
    const { key, name, version, resolution } = pkg;
    switch (resolution.kind) {
      case 'integrity':
        break;
      case 'tarball':
        out.push({
          kind: 'tarball',
          key,
          name,
          version,
          url: resolution.tarball,
          ...(resolution.integrity !== undefined && {
            integrity: resolution.integrity,
          }),
        });
        break;
      case 'git':
        out.push({
          kind: 'git',
          key,
          name,
          version,
          repo: resolution.repo,
          commit: resolution.commit,
          ...(resolution.path !== undefined && { path: resolution.path }),
        });
        break;
      case 'directory':
        out.push({
          kind: 'directory',
          key,
          name,
          version,
          directory: resolution.directory,
        });
        break;
      case 'variations':
        out.push({
          kind: 'runtime',
          key,
          name,
          version,
          variants: resolution.variants.length,
        });
        break;
    }
  }
  return out.sort((a, b) => compareKeys(a.key, b.key));
}
