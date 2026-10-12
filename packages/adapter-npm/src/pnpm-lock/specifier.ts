/**
 * The `specifier` an importer records: what package.json asked for, verbatim.
 * Only the forms that point somewhere other than a registry range are read
 * here; everything else is a range, a tag or a URL and stays text. A
 * `workspace:` specifier is `isWorkspaceSpecifier` of `@openpacker/adapter-core`,
 * which owns that rule (the workspace model reads the same text); it is not
 * defined a second time here.
 */

/**
 * The catalog a `catalog:` specifier names: `catalog:` is `default`,
 * `catalog:react17` is `react17`. Undefined for any other specifier.
 */
export function catalogOfSpecifier(specifier: string): string | undefined {
  if (!specifier.startsWith('catalog:')) return undefined;
  const name = specifier.slice('catalog:'.length);
  return name === '' ? 'default' : name;
}

/**
 * The package a `patchedDependencies` key patches: `name`, `name@1.2.3` or
 * `name@^1.2.0`, as package.json's `pnpm.patchedDependencies` spells it. The
 * lock keeps the key as configured, so it may be a range and need not be an
 * exact version.
 */
export function patchedPackageName(key: string): string {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}
