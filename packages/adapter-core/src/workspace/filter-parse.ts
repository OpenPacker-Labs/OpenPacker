import { WorkspaceError } from './errors.js';
import { compileGlob, type GlobAlternative } from './glob.js';
import type { WorkspaceLimits } from './limits.js';
import { resolveRelativeDirectory } from './spec.js';

/**
 * A selector of `--filter` as pnpm reads it:
 *
 * | written            | selects                                                  |
 * | ------------------ | -------------------------------------------------------- |
 * | `name`, `@s/*`     | members by name; `*` is the only wildcard and crosses "/"|
 * | `./path`, `../path`| members at or below that directory                       |
 * | `{packages/**}`    | members whose directory matches that pattern             |
 * | `name...`          | the member and everything it depends on                  |
 * | `...name`          | the member and everything that depends on it             |
 * | `name^...`, `...^name` | the same, without the member itself                  |
 * | `!selector`        | takes the members it selects away from the others        |
 * | `name{dir}`        | the members of that name inside that directory           |
 *
 * `[since]` selects by git history and is refused until opm can ask git.
 */
export type DirectoryMatch =
  | { readonly kind: 'subtree'; readonly dir: string }
  | {
      readonly kind: 'glob';
      readonly alternatives: readonly GlobAlternative[];
    };

export interface FilterSelector {
  /** The selector as written, for messages. */
  readonly source: string;
  readonly exclude: boolean;
  readonly includeDependencies: boolean;
  readonly includeDependents: boolean;
  readonly excludeSelf: boolean;
  readonly name: string | undefined;
  readonly directory: DirectoryMatch | undefined;
}

export interface FilterContext {
  /** The directory the command ran in, relative to the workspace root; `''` is the root. */
  readonly cwd: string;
  readonly limits: WorkspaceLimits;
}

function invalid(source: string, problem: string): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_FILTER_INVALID',
    `The filter ${JSON.stringify(source)} ${problem}`,
    [source],
  );
}

const PARTS = /^([^.][^{}[\]]*)?(\{[^}]+\})?(\[[^\]]+\])?$/u;

function isLocation(text: string): boolean {
  if (!text.startsWith('.')) return false;
  if (text === '.' || text.startsWith('./')) return true;
  return text === '..' || text.startsWith('../');
}

function directoryOf(
  inner: string,
  source: string,
  context: FilterContext,
): DirectoryMatch {
  if (inner.includes('\\'))
    throw invalid(source, 'uses a backslash; write the path with "/"');
  if (inner.includes('{'))
    throw invalid(source, 'nests braces in a directory selector');
  const meta = /[*?]/u.test(inner);
  if (!meta) {
    const dir = resolveRelativeDirectory(context.cwd, inner);
    if (dir === undefined) throw invalid(source, 'leaves the workspace root');
    return { kind: 'subtree', dir };
  }
  const parts = context.cwd === '' ? [] : context.cwd.split('/');
  for (const part of inner.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined)
        throw invalid(source, 'leaves the workspace root');
    } else parts.push(part);
  }
  const alternatives = compileGlob(parts.join('/'), context.limits);
  return { kind: 'glob', alternatives };
}

/** Parse one `--filter` value. Refuses what it would have to guess at, by name. */
export function parseFilter(
  source: string,
  context: FilterContext,
): FilterSelector {
  let rest = source.trim();
  if (rest === '') throw invalid(source, 'is empty');
  const exclude = rest.startsWith('!');
  if (exclude) rest = rest.slice(1);
  let excludeSelf = false;
  const includeDependencies = rest.endsWith('...');
  if (includeDependencies) {
    rest = rest.slice(0, -3);
    if (rest.endsWith('^')) {
      excludeSelf = true;
      rest = rest.slice(0, -1);
    }
  }
  const includeDependents = rest.startsWith('...');
  if (includeDependents) {
    rest = rest.slice(3);
    if (rest.startsWith('^')) {
      excludeSelf = true;
      rest = rest.slice(1);
    }
  }
  const parts = PARTS.exec(rest);
  if (parts === null) {
    if (!isLocation(rest))
      throw invalid(
        source,
        'is not a package name, a ./directory or a {directory}',
      );
    if (includeDependencies || includeDependents)
      throw new WorkspaceError(
        'WORKSPACE_FILTER_UNSUPPORTED',
        `The filter ${JSON.stringify(source)} adds "..." to a directory; pnpm ignores the dots there, so write {${rest}}... to select what depends on a directory`,
        [source],
      );
    return {
      source,
      exclude,
      includeDependencies,
      includeDependents,
      excludeSelf: false,
      name: undefined,
      directory: directoryOf(rest, source, context),
    };
  }
  if (parts[3] !== undefined)
    throw new WorkspaceError(
      'WORKSPACE_FILTER_UNSUPPORTED',
      `The filter ${JSON.stringify(source)} selects by git history ([since]), which is not supported yet`,
      [source],
    );
  const name = parts[1];
  const braces = parts[2];
  if (name === undefined && braces === undefined)
    throw invalid(source, 'names nothing');
  if (name !== undefined && name.startsWith('!'))
    throw invalid(source, 'negates twice');
  if (name !== undefined && /^[{}[\]]/u.test(name))
    throw invalid(source, 'has a stray brace or bracket');
  return {
    source,
    exclude,
    includeDependencies,
    includeDependents,
    excludeSelf,
    name,
    directory:
      braces === undefined
        ? undefined
        : directoryOf(braces.slice(1, -1), source, context),
  };
}

/** `*` is the only wildcard and matches any run of characters, "/" included; `?` is a literal. */
export function starMatches(pattern: string, name: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === name;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (
    name.length < first.length + last.length ||
    !name.startsWith(first) ||
    !name.endsWith(last)
  )
    return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = name.indexOf(middle, at);
    if (found === -1 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}
