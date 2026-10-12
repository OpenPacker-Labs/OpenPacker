/**
 * Recorded workspace-member links as an opaque leaf of a tree walk.
 *
 * A walk of a tree that refuses every link (`layout.ts`) must still be able to
 * read `node_modules` once a workspace's members are linked into it. The rule
 * is that a link is read and not entered: its path and text are recorded, the
 * directory it points at is never opened, listed, hashed or counted, and a
 * link is accepted only when the layout's own record says it wrote exactly
 * that link at exactly that path. Any other link, and a recorded path whose
 * link now says something else, is refused as before.
 */

import type { FileHandle } from 'node:fs/promises';
import { readlinkChild, type LinkSite } from './handle-link.js';

/** What the layout's record says it wrote under the directory being walked. */
export interface RecordedLinks {
  /** The project root as an absolute path; a Windows junction's text is relative to it. */
  projectRoot: string;
  /** Where the walked directory sits in the project, `/`-separated: `node_modules`. */
  base: string;
  /** The text of each recorded link, by its path relative to the walked directory. */
  links: ReadonlyMap<string, string>;
}

/** A recorded link met during a walk. */
export interface CollectedLink {
  /** Relative to the walk, with the walk's prefix. */
  path: string;
  /** The link's text, equal to the record's. */
  target: string;
}

/**
 * The text of the entry `name` of `directory` (`at` below the walked root) if
 * it is a link the record names with that very text, else undefined and the
 * caller refuses it. The link is read, never followed.
 */
export async function recordedLinkText(
  directory: FileHandle,
  name: string,
  at: string,
  recorded: RecordedLinks | undefined,
): Promise<string | undefined> {
  if (recorded === undefined) return undefined;
  const wanted = recorded.links.get(at === '' ? name : `${at}/${name}`);
  if (wanted === undefined) return undefined;
  const site: LinkSite = {
    directory: at === '' ? recorded.base : `${recorded.base}/${at}`,
    projectRoot: recorded.projectRoot,
  };
  try {
    const text = await readlinkChild(directory, name, site);
    return text === wanted ? text : undefined;
  } catch {
    return undefined;
  }
}
