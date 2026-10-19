import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBwrapArgv, createNativeBackend, runInSandbox } from './index.js';

/**
 * bwrap run by root keeps root's capabilities for the sandboxed process unless
 * told to drop them (a caller with uid 0 "can drop them via --cap-drop", in
 * bwrap's own words), and CAP_SYS_ADMIN undoes every read-only bind:
 * `mount -o remount,bind,rw <store>` and the store is writable. Run as any
 * other user, bwrap gives the process no capabilities at all.
 */

const backend = createNativeBackend();
const isRoot = process.getuid?.() === 0;

const argvFor = (asRoot: boolean) =>
  buildBwrapArgv({
    bwrap: '/usr/bin/bwrap',
    command: ['/bin/true'],
    cwd: '/tmp',
    readwritePaths: [],
    readonlyPaths: [],
    network: false,
    profile: 'package-exec',
    asRoot,
  });

describe('the capabilities of a sandboxed process', () => {
  it('are all dropped when bwrap runs as root', () => {
    const argv = argvFor(true);
    const at = argv.indexOf('--cap-drop');
    expect(argv[at + 1]).toBe('ALL');
    // Before the command, and before the `--` that ends bwrap's options.
    expect(at).toBeLessThan(argv.indexOf('--'));
    expect(argvFor(false)).not.toContain('--cap-drop');
  });

  it.runIf(isRoot && backend !== undefined)(
    'leave a read-only bind read-only when the caller is root',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'op-root-caps-'));
      const store = join(dir, 'store');
      const work = join(dir, 'work');
      mkdirSync(store);
      mkdirSync(work);
      writeFileSync(join(store, 'file'), 'original\n');
      try {
        const script = [
          'grep CapEff /proc/self/status',
          `mount -o remount,bind,rw ${store} && echo remounted-rw`,
          `echo changed > ${store}/file && echo wrote`,
        ].join('; ');
        const outcome = await runInSandbox({
          argv: ['/bin/sh', '-c', script],
          cwd: work,
          policy: { mode: 'fail-closed', prefer: 'native' },
          profile: 'package-exec',
          readwritePaths: [],
          readonlyPaths: [store],
          backend: backend!,
        });
        expect(outcome.enforced).toBe(true);
        expect(outcome.stdout).toContain('CapEff:\t0000000000000000');
        expect(outcome.stdout).not.toContain('remounted-rw');
        expect(outcome.stdout).not.toContain('wrote');
        expect(readFileSync(join(store, 'file'), 'utf8')).toBe('original\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Say why, where this cannot be shown: only root keeps capabilities.
  it.skipIf(isRoot && backend !== undefined)(
    'leave a read-only bind read-only when the caller is root ' +
      '(needs root and a trusted bwrap; not checked on this host)',
    () => {},
  );
});
