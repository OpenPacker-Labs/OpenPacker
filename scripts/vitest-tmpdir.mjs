/**
 * Vitest globalSetup: a test run's temporary directories are made in one of
 * its own, and the run fails if it left anything there.
 *
 * Suites make their scratch directories with `mkdtemp(join(tmpdir(), …))`,
 * and one that forgot to remove them left them in the shared /tmp, run after
 * run (`op-sandbox-output-*`, `opm-life-*`). Here `TMPDIR`, which `tmpdir()`
 * reads, names a directory made for the run before any worker starts; when the
 * run ends, whatever is in it is named in the failure, and removed either way.
 *
 * Two things in it are not a suite's: Node's compile cache, and the sandbox's
 * jail root (`openpacker-sandbox`), which every sandboxed run shares and keeps.
 * A jail home left in that root is a run that did not remove its own, and is
 * named like anything else.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEPT = new Set(['node-compile-cache']);
const JAIL_ROOT = 'openpacker-sandbox';

/** What a run left in `root`, by name. */
export function leftovers(root) {
  return readdirSync(root).flatMap((name) => {
    if (KEPT.has(name)) return [];
    if (name !== JAIL_ROOT) return [name];
    return readdirSync(join(root, name)).map((home) => `${name}/${home}`);
  });
}

export default function setup() {
  const before = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), 'openpacker-test-'));
  // Others may look in, as in /tmp: a test runs a child as another user on
  // what it made there (store-lease.proc.test.ts). Only the run writes here.
  chmodSync(root, 0o755);
  process.env.TMPDIR = root;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    const left = leftovers(root);
    rmSync(root, { recursive: true, force: true });
    if (left.length > 0)
      throw new Error(
        `The tests left ${left.length} entries in their temporary directory; ` +
          `remove each where it is made: ${left.sort().join(', ')}`,
      );
  };
}
