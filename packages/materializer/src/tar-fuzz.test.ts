/**
 * A bounded run of the differential fuzz (test/tar-fuzz) in the suite: every
 * family, 300 archives drawn with a fixed seed, read by node-tar 6.2.1 (whole,
 * in pieces and as `tar.x` with pacote's filter), node-tar 7.5.22 the same way
 * when it is there, pnpm 10.28.0 and opm in npm mode, and no archive may land
 * in an UNSAFE class. About 20 seconds. The readers are release
 * directories: OPENPACKER_NODE_TAR_6_DIR, OPENPACKER_PNPM_DIR and
 * OPENPACKER_NODE_TAR_7_DIR, or else the npm and pnpm installed beside the
 * running node (npm 10.9 bundles node-tar 6.2.1). Without node-tar 6.2.1 or
 * pnpm 10.28.0 the run is skipped and says so; the long runs are run.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../test/tar-fuzz/families.mjs';
import { openReaders, runFamily } from '../test/tar-fuzz/fuzz.mjs';
import * as opm from './index.js';

const SEED = 20261024;
const COUNT = 300;

const prefix = dirname(dirname(process.execPath));
/** `directory` if it holds `name` at `version`, else undefined. */
function release(
  directory: string | undefined,
  name: string,
  version: string,
): string | undefined {
  if (directory === undefined || !existsSync(join(directory, 'package.json')))
    return undefined;
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  return manifest.name === name && manifest.version === version
    ? directory
    : undefined;
}

const nodeTar6 = release(
  process.env.OPENPACKER_NODE_TAR_6_DIR ??
    join(prefix, 'lib', 'node_modules', 'npm', 'node_modules', 'tar'),
  'tar',
  '6.2.1',
);
const pnpm = release(
  process.env.OPENPACKER_PNPM_DIR ??
    join(prefix, 'lib', 'node_modules', 'pnpm'),
  'pnpm',
  '10.28.0',
);
const nodeTar7 = release(
  process.env.OPENPACKER_NODE_TAR_7_DIR,
  'tar',
  '7.5.22',
);
const missing = nodeTar6 === undefined || pnpm === undefined;

describe.skipIf(missing)(
  `the differential fuzz, ${COUNT} archives a family (seed ${SEED})`,
  () => {
    it.each(Object.keys(FAMILIES))(
      '%s: no archive npm and pnpm read differently is extracted',
      async (name) => {
        const readers = openReaders({
          opm,
          nodeTar6: nodeTar6!,
          nodeTar7,
          pnpm: pnpm!,
          pacote: true,
        });
        try {
          const run = await runFamily(readers, FAMILIES[name]!(SEED, COUNT));
          expect(run.total).toBe(COUNT);
          expect(Object.fromEntries(run.samples)).toEqual({});
          expect(run.unsafe).toBe(0);
        } finally {
          await readers.close();
        }
      },
      60_000,
    );
  },
);

it.runIf(missing)(
  'the differential fuzz needs node-tar 6.2.1 and pnpm 10.28.0',
  () => {
    console.warn(
      'tar-fuzz.test.ts skipped: set OPENPACKER_NODE_TAR_6_DIR and OPENPACKER_PNPM_DIR (test/tar-fuzz/README.md)',
    );
  },
);
