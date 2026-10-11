/** `@scope/Name` → `pkg:npm/%40scope/name`, the canonical form the codec uses. */
export function npmPurl(name: string): string {
  const lower = name.toLowerCase();
  if (!lower.startsWith('@')) return `pkg:npm/${encodeURIComponent(lower)}`;
  const slash = lower.indexOf('/');
  if (slash === -1) return `pkg:npm/${encodeURIComponent(lower)}`;
  return `pkg:npm/%40${encodeURIComponent(lower.slice(1, slash))}/${encodeURIComponent(lower.slice(slash + 1))}`;
}
