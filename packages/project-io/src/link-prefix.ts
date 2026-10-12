/**
 * Where a member link's target leads, beyond its text.
 *
 * `linkTargetProblem` keeps the text of a target inside the project root, which
 * is a statement about a string. If a component the target passes through
 * already exists and is itself a link, the link resolves wherever that leads: a
 * committed `packages -> ../outside` is enough. So the nearest existing prefix
 * of the target is walked here, from the project root, with the same no-follow
 * opens the link's own directory is reached with, and the first component that
 * is a link (a reparse point on Windows) is reported.
 *
 * A target that does not exist yet is allowed, so only the part that exists is
 * walked: the walk stops at the first component that is missing, and at the
 * first that is not a directory, since nothing deeper can be resolved through
 * it. This is a check at the moment of the call. It cannot make a later swap of
 * a component impossible; ADR 0050 says who closes that window.
 */

import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import type { LinkSite } from './handle-link.js';
import { openProjectDirectory, stepPlainDirectory } from './stable-open.js';

/**
 * The project-root relative path of the first component on the way to the
 * place `target` names (from `site.directory`) that exists and is a link, or
 * undefined when everything that exists on the way is a plain directory.
 *
 * The caller has already checked the text of `target` against the link rules,
 * so the place is inside the project root and has no `..` left in it.
 */
export async function linkOnTheWayTo(
  site: LinkSite,
  target: string,
): Promise<string | undefined> {
  const place = posix.normalize(posix.join(site.directory, target));
  let handle = await openProjectDirectory(
    await realpath(resolve(site.projectRoot)),
    false,
  );
  const walked: string[] = [];
  try {
    for (const part of place.split('/')) {
      const step = await stepPlainDirectory(handle, part);
      if (step.kind === 'link') return [...walked, part].join('/');
      if (step.kind !== 'directory') return undefined;
      await handle.close();
      handle = step.handle;
      walked.push(part);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
