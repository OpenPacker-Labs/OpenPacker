import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Workspace libraries under `packages/` whose `exports["."]` names both an
 * ESM `import` target and a CommonJS `require` target.
 *
 * Every workspace sets `private: true`, because `@openpacker/cli` is the only
 * package published to npm. `private` blocks `npm publish`. It does not mean
 * the library has no dual export map. Callers pack and load these packages
 * anyway, so a clean consumer can install `@openpacker/sdk` and the libraries
 * it depends on.
 *
 * @param {string} root Repository root that contains `packages/`.
 * @returns {{ directory: string, manifest: object }[]} Sorted by directory name.
 */
export function dualExportPackages(root) {
  const packagesDirectory = join(root, 'packages');
  return readdirSync(packagesDirectory)
    .map((directory) => ({
      directory,
      manifest: JSON.parse(
        readFileSync(
          join(packagesDirectory, directory, 'package.json'),
          'utf8',
        ),
      ),
    }))
    .filter(({ manifest }) => {
      const entry = manifest.exports?.['.'];
      return (
        typeof entry?.import === 'string' && typeof entry?.require === 'string'
      );
    })
    .sort((left, right) =>
      left.directory < right.directory
        ? -1
        : left.directory > right.directory
          ? 1
          : 0,
    );
}
