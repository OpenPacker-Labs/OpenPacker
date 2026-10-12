/**
 * The names a workspace is built from.
 *
 * A member's name becomes a directory under `node_modules` and a dependency's
 * name becomes the name of a link, so a name is checked against the narrowest
 * set of characters a directory name can safely hold, not only against the
 * registry's rules. This is the same set the `node_modules` layout accepts, so
 * a name the workspace admits can always be laid out.
 */

const NAME_BODY = /^[A-Za-z0-9._~+-]+$/u;
const MAXIMUM_NAME_LENGTH = 214;
const RESERVED = new Set(['node_modules', 'favicon.ico']);

/** Why `name` cannot name a package here, or `undefined` when it can. */
export function workspaceNameProblem(name: string): string | undefined {
  const shown = JSON.stringify(name);
  if (name === '') return 'a package name cannot be empty';
  if (name.length > MAXIMUM_NAME_LENGTH)
    return `${shown.slice(0, 48)}... is longer than ${MAXIMUM_NAME_LENGTH} characters`;
  const scoped = name.startsWith('@');
  const segments = name.split('/');
  if (segments.length !== (scoped ? 2 : 1))
    return `${shown} is not a package name (a scoped name is @scope/name and nothing else contains "/")`;
  for (const [index, segment] of segments.entries()) {
    const body = scoped && index === 0 ? segment.slice(1) : segment;
    if (body === '') return `${shown} has an empty scope or name`;
    if (body.startsWith('.') || body.startsWith('_'))
      return `${shown} cannot start a name or scope with "." or "_"`;
    if (RESERVED.has(body)) return `${shown} uses the reserved name ${body}`;
    if (!NAME_BODY.test(body))
      return `${shown} uses characters a directory name cannot safely hold (letters, digits and . _ ~ + - only)`;
  }
  return undefined;
}

/** Plain code-unit order: the same on every machine, whatever its locale. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
