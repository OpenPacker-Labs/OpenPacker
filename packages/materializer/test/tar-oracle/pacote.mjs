/**
 * What `npm install` writes from a tarball: node-tar's `tar.x` with the options
 * and filter of pacote 19.0.1 (lib/fetcher.js `#tarxOptions`, the pacote npm
 * 10.9.4 bundles), to a directory, read back. Links and every entry that is not
 * a file are skipped, the first path component is stripped, and a `.gitignore`
 * is renamed `.npmignore` unless one was already seen (then it is dropped). The
 * rest of the oracle reads node-tar's `Parse` directly; this is the same reader
 * as pacote runs it, so the oracle can say what the filter changes.
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

function filesUnder(directory, prefix = '') {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? filesUnder(path, `${prefix}${name}/`)
      : [[`${prefix}${name}`, readFileSync(path).toString()]];
  });
}

/** The files `tar.x` with pacote's filter extracts from `bytes`, sorted by path. */
export async function pacoteInstalls(tar, bytes) {
  const cwd = mkdtempSync(join(tmpdir(), 'tar-oracle-'));
  const sawIgnores = new Set();
  try {
    await new Promise((resolve, reject) => {
      const extract = tar.x({
        cwd,
        noChmod: true,
        noMtime: true,
        strip: 1,
        preserveOwner: false,
        onwarn: () => undefined,
        filter: (_, entry) => {
          if (/Link$/u.test(entry.type)) return false;
          if (!/File$/u.test(entry.type)) return false;
          const base = basename(entry.path);
          if (base === '.npmignore') sawIgnores.add(entry.path);
          else if (base === '.gitignore') {
            const renamed = entry.path.replace(/\.gitignore$/u, '.npmignore');
            if (sawIgnores.has(renamed)) return false;
            entry.path = renamed;
          }
          return true;
        },
      });
      extract.on('close', resolve);
      extract.on('error', reject);
      extract.end(bytes);
    });
    return {
      entries: filesUnder(cwd).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    };
  } catch (error) {
    return { error: error.code ?? error.message };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
