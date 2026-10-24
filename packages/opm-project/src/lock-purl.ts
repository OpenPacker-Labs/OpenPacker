/**
 * The one spelling a lock gives a PURL.
 *
 * An npm scope can be typed `pkg:npm/@scope/name` (as npm writes it) or
 * `pkg:npm/%40scope/name` (as the PURL spec encodes it: purl-spec
 * types/npm-definition.json, "The npm scope @ sign prefix is always percent
 * encoded"). They name one package, and a lock that holds both holds one
 * identity twice: entries a comparison takes for two packages, and a resolve
 * of the same project that writes a different lock depending on how a name
 * was typed. Every PURL a lock is read with or written with is the encoded one.
 */
export function canonicalLockPurl(purl: string): string {
  return purl.replace(/^pkg:npm\/@/u, 'pkg:npm/%40');
}
