/**
 * Running this package's TypeScript sources in a separate `node` process, for
 * the tests that need a holder they can kill, another user, or another mount.
 */

import { fileURLToPath } from 'node:url';

/** The package's `src/<name>.ts`, as a file a child can import. */
export function source(name: string): string {
  return fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url));
}

/**
 * `node` arguments that run `script` (an ES module's text) with the
 * package's sources importable; `args` follow it as `process.argv.slice(1)`.
 */
export function tsNodeArgs(script: string, args: readonly string[]): string[] {
  return [
    '--experimental-transform-types',
    '--import',
    new URL('./fixtures/ts-resolve.mjs', import.meta.url).href,
    '--input-type=module',
    '-e',
    script,
    ...args,
  ];
}

/** The environment a child runs in: the parent's, without its notices. */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_NO_WARNINGS: '1', ...extra };
}
