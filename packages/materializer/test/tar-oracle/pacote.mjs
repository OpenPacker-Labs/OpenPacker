/**
 * What `npm install` writes from a tarball: node-tar's `tar.x` with the options
 * and filter of pacote 19.0.1 (lib/fetcher.js `#tarxOptions`, the pacote npm
 * 10.9.4 bundles), to a directory, read back. Links and every entry that is not
 * a file are skipped, the first path component is stripped, and a `.gitignore`
 * is renamed `.npmignore` unless one was already seen (then it is dropped). The
 * rest of the oracle reads node-tar's `Parse` directly; this is the same reader
 * as pacote runs it, so the oracle can say what the filter changes, and what
 * `tar.x` does that `Parse` does not (node-tar 6.2.1 throws on a numeric pax
 * `linkpath`, node-tar 7.5.22 drops a file whose `linkpath` leaves the
 * directory). Execute bits are read from the files written.
 *
 * A crash is the answer, not a failure of the oracle: `tar.x` can throw from
 * inside a stream, which is an uncaught exception in the process, so it is
 * caught here and recorded as `error`, and a run that never ends as `timeout`.
 */

import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const TIMEOUT_MS = 5000;

function filesUnder(directory, prefix = '') {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    return stat.isDirectory()
      ? filesUnder(path, `${prefix}${name}/`)
      : [
          {
            path: `${prefix}${name}`,
            text: readFileSync(path).toString(),
            executable: (stat.mode & 0o111) !== 0,
          },
        ];
  });
}

/** The files `tar.x` with pacote's filter extracts from `bytes`, sorted by path. */
export async function pacoteInstalls(reader, bytes) {
  const cwd = mkdtempSync(join(tmpdir(), 'tar-oracle-'));
  const sawIgnores = new Set();
  let onUncaught;
  let timer;
  try {
    const failure = await new Promise((resolve) => {
      onUncaught = (error) =>
        resolve(`uncaught ${error.code ?? error.message}`);
      process.once('uncaughtException', onUncaught);
      timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
      const extract = reader.module.x({
        cwd,
        noChmod: true,
        noMtime: true,
        strip: 1,
        preserveOwner: false,
        onwarn: () => undefined,
        filter: (_, entry) => {
          if (entry.type.endsWith('Link')) return false;
          if (!entry.type.endsWith('File')) return false;
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
      extract.on('close', () => resolve(undefined));
      extract.on('error', (error) => resolve(error.code ?? error.message));
      try {
        extract.end(bytes);
      } catch (error) {
        resolve(`throw ${error.code ?? error.message}`);
      }
    });
    const files = filesUnder(cwd).sort((left, right) =>
      left.path < right.path ? -1 : 1,
    );
    const installed = {
      entries: files.map(({ path, text }) => [path, text]),
      executable: files
        .filter((file) => file.executable)
        .map(({ path }) => path),
    };
    if (failure !== undefined) installed.error = failure;
    return installed;
  } finally {
    clearTimeout(timer);
    process.off('uncaughtException', onUncaught);
    rmSync(cwd, { recursive: true, force: true });
  }
}
