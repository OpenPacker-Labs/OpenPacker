import { tmpdir } from 'node:os';
import { relative } from 'node:path';
import {
  enableDefaultSharedStore,
  sharedStoreRoot,
  toolCacheRoot,
} from '@openpacker/opm-project';
import { pluginStoreRoot } from '@openpacker/plugin-store';
import { describe, expect, it } from 'vitest';

/**
 * `opm` and `opmx` turn the user-level shared store on, the plugin commands use
 * the user-level plugin store, and a test that runs either inherits this
 * process's environment. Without isolation those are the caller's real ones
 * (`~/.cache/openpacker/store` or OPM_STORE_HOME, and
 * `~/.local/share/openpacker/plugins` or OPM_PLUGIN_HOME).
 */

const insideTmp = (path: string | undefined) => {
  const rel = relative(tmpdir(), path ?? '/');
  return rel !== '' && !rel.startsWith('..');
};

describe("opm's tests and the caller's stores", () => {
  it('gives a process entry a fresh store, tool cache and plugin store, not the caller ones', () => {
    expect(process.env.OPM_STORE_HOME).toBeUndefined();
    expect(insideTmp(pluginStoreRoot())).toBe(true);
    enableDefaultSharedStore();
    try {
      expect(insideTmp(sharedStoreRoot())).toBe(true);
      expect(insideTmp(toolCacheRoot())).toBe(true);
    } finally {
      enableDefaultSharedStore(false);
    }
  });
});
