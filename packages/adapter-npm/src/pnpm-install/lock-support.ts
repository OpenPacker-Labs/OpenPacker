/**
 * Small pnpm locks written for a case, in pnpm's own shape, for the suites that
 * need one shape of lock and not a real one (`select`, `refuse`, `stale`).
 */

/** A well formed sha512 integrity. */
export const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`;

export const LOCK = (body: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

${body}
`;

/** A `packages` entry; `extra` is more lines of it (`    cpu: [x64]\n`). */
export const pkg = (key: string, extra = ''): string =>
  `  '${key}':\n    resolution: {integrity: ${INTEGRITY}}\n${extra}`;

/** One direct dependency of an importer, at 6 spaces. */
export const dependency = (
  name: string,
  specifier: string,
  version: string,
): string =>
  `      '${name}':\n        specifier: '${specifier}'\n        version: '${version}'\n`;
