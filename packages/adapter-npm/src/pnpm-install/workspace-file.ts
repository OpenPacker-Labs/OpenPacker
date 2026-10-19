/**
 * `pnpm-workspace.yaml` as a frozen install reads it (ADR 0055 §18).
 *
 * The file is input from the repository, read before anything in it is
 * trusted, exactly as the lock is: opened without following a link, a regular
 * file of at most a megabyte, strictly UTF-8, and parsed by the lock's own
 * bounded reader (`readYamlTree`), so the same ceilings hold (lexemes and
 * nesting counted as the text is read, repeated keys found in linear time) and
 * the same YAML is refused (tags, anchors, aliases, directives, a second
 * document). A file that is not there is no settings at all.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from '@openpacker/adapter-core';
import { PnpmLockError } from '../pnpm-lock/errors.js';
import { resolvePnpmLockLimits } from '../pnpm-lock/limits.js';
import {
  readYamlTree,
  type YamlList,
  type YamlMap,
  type YamlValue,
} from '../pnpm-lock/yaml-tree.js';

export const MAXIMUM_WORKSPACE_BYTES = 1024 * 1024;

const LIMITS = resolvePnpmLockLimits({ maxBytes: MAXIMUM_WORKSPACE_BYTES });

/** The file's tree with every map an object, as `JSON.parse` would give it. */
export type WorkspaceValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkspaceValue[]
  | { readonly [key: string]: WorkspaceValue };

/** The reader's maps as objects whose keys are own data properties, so `__proto__` is data. */
function plain(value: YamlValue): WorkspaceValue {
  if (typeof value !== 'object' || value === null) return value;
  if (isList(value)) return value.map(plain);
  return Object.fromEntries(
    [...value].map(([key, entry]) => [key, plain(entry)]),
  );
}

function isList(value: YamlList | YamlMap): value is YamlList {
  return Array.isArray(value);
}

function isPlainList(
  value: readonly WorkspaceValue[] | { readonly [key: string]: WorkspaceValue },
): value is readonly WorkspaceValue[] {
  return Array.isArray(value);
}

/** The bytes of the file, or undefined when there is none. */
async function readBytes(path: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP')
      throw new ProviderError(
        'UNSAFE_PATH',
        `${JSON.stringify(path)} is a symbolic link; opm ci reads pnpm-workspace.yaml itself and not what a link points at`,
      );
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_WORKSPACE_BYTES)
      throw new ProviderError(
        'INVALID_MANIFEST',
        `${JSON.stringify(path)} is not a regular file of at most ${MAXIMUM_WORKSPACE_BYTES} bytes`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * The top level of `pnpm-workspace.yaml` in `root` as plain data; empty when
 * the file is absent or empty. Throws `UNSAFE_PATH` for a link and
 * `INVALID_MANIFEST` for anything the lock's reader would refuse.
 */
export async function readWorkspaceFile(
  root: string,
): Promise<Readonly<Record<string, WorkspaceValue>>> {
  const path = join(root, 'pnpm-workspace.yaml');
  const bytes = await readBytes(path);
  if (bytes === undefined) return {};
  const refuse = (message: string): never => {
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${JSON.stringify(path)} ${message}`,
    );
  };
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('is not valid UTF-8');
  }
  let tree: YamlValue = null;
  try {
    tree = readYamlTree(text, LIMITS);
  } catch (error) {
    if (!(error instanceof PnpmLockError)) throw error;
    // No document at all (empty, or comments only) is a file that sets nothing.
    if (error.reason === 'yaml-syntax' && error.message.endsWith(' is empty'))
      return {};
    // The reader's sentence is about this file; a limit is opm's own for it,
    // and not the lock's setting the lock's message names.
    refuse(
      error.limit === undefined
        ? error.sentence
        : `${error.sentence} (opm's limit for a pnpm-workspace.yaml, which no setting changes)`,
    );
  }
  const value = plain(tree);
  return typeof value === 'object' && value !== null && !isPlainList(value)
    ? value
    : {};
}
