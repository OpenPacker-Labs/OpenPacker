import { isAbsolute } from 'node:path';

/**
 * How the browser gates and the demo launch Chromium.
 *
 * Playwright launches the browser revision it downloaded with
 * `npm exec playwright install chromium`. PLAYWRIGHT_CHROMIUM names a Chromium
 * executable to launch instead, for a machine that already has one at a fixed
 * path and may not download another (a CI image or an agent sandbox). It must
 * be absolute: a relative one would follow whatever directory a gate runs in.
 */
export function chromiumLaunchOptions(env = process.env) {
  const executablePath = env.PLAYWRIGHT_CHROMIUM?.trim();
  if (!executablePath) return { headless: true };
  if (!isAbsolute(executablePath))
    throw new Error(
      `PLAYWRIGHT_CHROMIUM must be an absolute path to a Chromium executable, got "${executablePath}"`,
    );
  return { headless: true, executablePath };
}
