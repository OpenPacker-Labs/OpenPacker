import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// Each of these serves files to a browser from a local HTTP server. When the
// browser cannot start, the failure has to be reported and the process has to
// end; a server left listening keeps it alive, and so keeps `npm run
// test:browser` (and anything that waits on it) from ever returning.
const browserTests = [
  'tests/browser/wasm.test.mjs',
  'examples/epoch-consumer/test/sdk-browser.playwright.mjs',
];

for (const file of browserTests)
  test(`${file} ends when the browser cannot start`, () => {
    const empty = mkdtempSync(join(tmpdir(), 'openpacker-no-browsers-'));
    try {
      const result = spawnSync(process.execPath, ['--test', join(root, file)], {
        cwd: root,
        encoding: 'utf8',
        // NODE_TEST_CONTEXT would make the child report to this runner and exit 0.
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          PLAYWRIGHT_BROWSERS_PATH: empty,
        },
        timeout: 40_000,
      });
      assert.equal(result.error, undefined, 'the process had to be killed');
      assert.equal(result.signal, null, 'the process had to be killed');
      assert.notEqual(result.status, 0, 'a missing browser must fail the test');
      assert.match(result.stdout, /Executable doesn't exist/u);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
