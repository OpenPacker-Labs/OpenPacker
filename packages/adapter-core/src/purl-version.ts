/**
 * Where a purl's path ends and its version begins: the last `@`, unless
 * nothing precedes it. An `@` that begins the path is an npm scope typed as
 * people type it (`pkg:npm/@vercel/sdk`), not a version separator: the name
 * would be empty. It stays in the path, to be read as `%40`, and `formatPurl`
 * writes it back that way, as the npm type requires (purl-spec
 * types/npm-definition.json).
 */
export function splitPurlVersion(pathAndVersion: string): {
  path: string;
  version: string | undefined;
} {
  const at = pathAndVersion.lastIndexOf('@');
  return at > 0
    ? {
        path: pathAndVersion.slice(0, at),
        version: pathAndVersion.slice(at + 1),
      }
    : { path: pathAndVersion, version: undefined };
}
