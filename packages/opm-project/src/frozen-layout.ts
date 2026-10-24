/**
 * Writing `node_modules` from the shared store, and the check after it.
 *
 * An install's claims (`shared-store-lease.ts`) keep `opm gc --shared` away
 * from every entry it links from. Something that does not honour claims (an
 * older opm's collection, or a person) can still remove one: the layout then
 * fails, or, when the removal comes after the links, leaves a project whose
 * files are in no store entry. So once the layout is written, every entry it
 * linked from is looked at. One whose directory vanished is fetched again and
 * proved against the lock, and the layout is written again, once; an entry
 * that is still missing after that is an error that names it. Only the
 * directory is looked at: an entry a person removed part of is not caught.
 */

import { lstat } from 'node:fs/promises';
import type { ProjectionResult } from '@openpacker/adapter-core';
import { OpmError } from './types.js';

export interface LayoutSource {
  /** The shared store entry a package is linked from. */
  storePath: string;
  /** The package, as a person reads it: `name@version (path)`. */
  label: string;
}

export async function layOutFromStore(input: {
  sources: readonly LayoutSource[];
  write: () => Promise<ProjectionResult>;
  /** Put the entries at these paths back in the store. */
  restore: (gone: ReadonlySet<string>) => Promise<void>;
}): Promise<ProjectionResult> {
  for (let round = 0; ; round += 1) {
    let layout: ProjectionResult | undefined;
    let failure: unknown;
    try {
      layout = await input.write();
    } catch (error) {
      failure = error;
    }
    const gone = await vanished(input.sources);
    if (gone.size === 0) {
      if (layout !== undefined) return layout;
      throw failure;
    }
    const named = describe(input.sources, gone);
    if (round > 0)
      throw new OpmError(
        'STORE_ENTRY_VANISHED',
        `${named} removed again while this install was linking from the store; something removes entries without honouring installs' claims`,
        { cause: failure },
      );
    try {
      await input.restore(gone);
    } catch (error) {
      throw notPutBack(named, error);
    }
  }
}

/** Why an entry could not be fetched again, as against what came being wrong. */
const UNAVAILABLE = new Set(['OFFLINE', 'FETCH_FAILED', 'UNAVAILABLE']);
/** What writing to a store this install may not write says. */
const UNWRITABLE = new Set(['EROFS', 'EACCES', 'EPERM']);

/**
 * The error for entries that could not be put back. Bytes fetched again that
 * do not match the lock, or that cannot be extracted safely, are that failure
 * (and exit as one), whatever made the fetch necessary; only an entry that
 * could not be had at all is `STORE_ENTRY_VANISHED`.
 */
function notPutBack(named: string, error: unknown): OpmError {
  const said = error instanceof Error ? error.message : String(error);
  const context = `${named} removed while this install was linking from the store, and could not be put back`;
  if (error instanceof OpmError && !UNAVAILABLE.has(error.code))
    return new OpmError(error.code, `${context}: ${said}`, { cause: error });
  // SAFETY: Node's file errors carry a string `code`; anything else has none.
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const why = UNWRITABLE.has(code)
    ? `this install cannot write the store (${said})`
    : said;
  return new OpmError('STORE_ENTRY_VANISHED', `${context}: ${why}`, {
    cause: error,
  });
}

async function vanished(
  sources: readonly LayoutSource[],
): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const path of new Set(sources.map((source) => source.storePath))) {
    const info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory() !== true) gone.add(path);
  }
  return gone;
}

function describe(
  sources: readonly LayoutSource[],
  gone: ReadonlySet<string>,
): string {
  const list = [...gone].sort().map((path) => {
    const labels = sources
      .filter((source) => source.storePath === path)
      .map((source) => source.label);
    return `${path} (${labels.join(', ')})`;
  });
  return list.length === 1
    ? `The shared store entry ${list[0]} was`
    : `The shared store entries ${list.join('; ')} were`;
}
