import assert from 'node:assert/strict';
import test from 'node:test';
import { chromiumLaunchOptions } from '../../scripts/chromium.mjs';

test('the browser gates launch the Chromium Playwright downloaded unless told another', () => {
  assert.deepEqual(chromiumLaunchOptions({}), { headless: true });
  assert.deepEqual(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM: '  ' }), {
    headless: true,
  });
  assert.deepEqual(
    chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM: '/opt/pw-browsers/chromium' }),
    { headless: true, executablePath: '/opt/pw-browsers/chromium' },
  );
  assert.throws(
    () => chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM: 'chromium' }),
    /must be an absolute path/u,
  );
});
