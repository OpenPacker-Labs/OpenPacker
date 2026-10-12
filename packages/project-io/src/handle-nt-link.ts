/**
 * Workspace-member links on Windows. Not written yet in this commit: the
 * functions refuse, so no caller can get a link by a path that was never
 * checked.
 */

import { type FileHandle } from 'node:fs/promises';
import { StableHandleError } from './handle-support.js';
import type { LinkSite } from './handle-link.js';

const UNAVAILABLE =
  'Workspace member links are not available on Windows in this build';

export function createJunction(
  _directory: FileHandle,
  _name: string,
  _target: string,
  _site: LinkSite,
): Promise<void> {
  return Promise.reject(new StableHandleError(UNAVAILABLE));
}

export function readJunction(
  _directory: FileHandle,
  _name: string,
  _site?: LinkSite,
): Promise<string> {
  return Promise.reject(new StableHandleError(UNAVAILABLE));
}
