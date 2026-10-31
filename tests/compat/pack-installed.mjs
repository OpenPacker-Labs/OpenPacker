import {
  cpSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Copy an installed dependency into `copy` with its manifest's `scripts` left
 * out, and without its own `node_modules`, so `npm pack <copy>` runs nothing
 * the dependency declares.
 *
 * `directory` may be a link (a workspace's `node_modules` entry, a pnpm-style
 * layout, a farm of links to a shared install), and so may anything inside it.
 * The copy is of what each link names, so the manifest written here is the
 * copy's own file and never the installed package's. A copy that is still a
 * link, or whose manifest is one, is refused before anything is written.
 */
export function copyWithoutScripts(directory, copy) {
  const source = realpathSync(directory);
  cpSync(source, copy, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      !relative(source, path).split(sep).includes('node_modules'),
  });
  const manifestPath = join(copy, 'package.json');
  for (const path of [copy, manifestPath])
    if (lstatSync(path).isSymbolicLink())
      throw new Error(
        `The copy of ${directory} is a link at ${path}; its manifest is not rewritten.`,
      );
  const { scripts: _scripts, ...manifest } = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
