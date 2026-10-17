/** `@scope/Name` → `pkg:npm/%40scope/name`, the canonical form the codec uses. */
export function npmPurl(name: string): string {
  const lower = name.toLowerCase();
  if (!lower.startsWith('@')) return `pkg:npm/${encodeURIComponent(lower)}`;
  const slash = lower.indexOf('/');
  if (slash === -1) return `pkg:npm/${encodeURIComponent(lower)}`;
  return `pkg:npm/%40${encodeURIComponent(lower.slice(1, slash))}/${encodeURIComponent(lower.slice(slash + 1))}`;
}

/**
 * `@scope/name` → `pkg:npm/%40scope/name`, per the PURL npm rules, with the
 * case a manifest spells it in (`npmPurl` lowercases, as the codec does).
 */
export function purlForName(name: string): string {
  if (!name.startsWith('@')) return `pkg:npm/${encodeURIComponent(name)}`;
  const slash = name.indexOf('/');
  if (slash === -1) return `pkg:npm/${encodeURIComponent(name)}`;
  return `pkg:npm/%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(
    name.slice(slash + 1),
  )}`;
}
