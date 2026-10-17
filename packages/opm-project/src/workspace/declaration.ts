import type { JsonValue } from '@openpacker/contracts';
import { WorkspaceError, type WorkspaceLimits } from '@openpacker/adapter-core';
import { Lexer, Parser, isMap, isScalar, isSeq, parseDocument } from 'yaml';

/** What `pnpm-workspace.yaml` says that the workspace model uses. */
export interface PnpmDeclaration {
  /** `packages:`, or `['.']` when it is absent, as pnpm defaults it. */
  readonly patterns: readonly string[];
  /** `linkWorkspacePackages:`, as pnpm reads it from this file; `undefined` when it is not set here. */
  readonly linkWorkspacePackages: boolean | 'deep' | undefined;
}

type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(problem: string): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_DECLARATION_INVALID',
    `pnpm-workspace.yaml ${problem}`,
    ['pnpm-workspace.yaml'],
  );
}

/** Deeper than any real declaration nests; `[` a megabyte long is refused here. */
const MAXIMUM_NESTING = 64;

/**
 * Refuse text that nests deeper than {@link MAXIMUM_NESTING}, watching the
 * parser's stack as the lexemes arrive, before a document is built: a megabyte
 * of `[` otherwise costs a second and close to a gigabyte to compose.
 */
function checkNesting(text: string): void {
  const parser = new Parser();
  for (const lexeme of new Lexer().lex(text)) {
    // The tokens are not kept; walking the generator is what moves the parser.
    for (const token of parser.next(lexeme)) void token;
    if (parser.stack.length > MAXIMUM_NESTING)
      throw invalid(`nests deeper than ${MAXIMUM_NESTING} levels`);
  }
}

/** The first key a mapping repeats, anywhere in the tree, by its scalar value. */
function firstRepeatedKey(node: unknown): string | undefined {
  if (isSeq(node))
    for (const item of node.items) {
      const found = firstRepeatedKey(item);
      if (found !== undefined) return found;
    }
  if (!isMap(node)) return undefined;
  const seen = new Set<string>();
  for (const pair of node.items) {
    if (isScalar(pair.key)) {
      const key = String(pair.key.value);
      if (seen.has(key)) return key;
      seen.add(key);
    }
    const found = firstRepeatedKey(pair.value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Read `pnpm-workspace.yaml`. A document that is not one YAML mapping, that
 * repeats a key, or whose `packages` is not a list of strings is refused;
 * every other key is pnpm's own setting and is left alone. Aliases are limited
 * so a small file cannot expand into a large one.
 */
export function parsePnpmWorkspaceYaml(
  text: string,
  limits: WorkspaceLimits,
): PnpmDeclaration {
  checkNesting(text);
  // The library's own repeated-key check compares each key with every earlier
  // one (40,000 catalog entries took 13 s); `firstRepeatedKey` is linear.
  const document = parseDocument(text, {
    version: '1.2',
    uniqueKeys: false,
    prettyErrors: false,
    logLevel: 'error',
  });
  const failure = document.errors[0];
  if (failure !== undefined)
    throw invalid(`is not valid YAML: ${failure.message.split('\n')[0]}`);
  const warning = document.warnings[0];
  if (warning !== undefined)
    throw invalid(`is not read: ${warning.message.split('\n')[0]}`);
  const repeated = firstRepeatedKey(document.contents);
  if (repeated !== undefined)
    throw invalid(
      `is not valid YAML: the key ${JSON.stringify(repeated)} is written twice in one mapping`,
    );
  let value: JsonValue;
  try {
    value = document.toJS({ maxAliasCount: 64 }) ?? null;
  } catch (error) {
    throw invalid(
      `cannot be expanded: ${error instanceof Error ? error.message : 'unreadable'}`,
    );
  }
  if (value === null)
    return { patterns: ['.'], linkWorkspacePackages: undefined };
  if (!isJsonObject(value)) throw invalid('must be a mapping at the top level');
  const packages = value['packages'];
  let patterns: readonly string[] = ['.'];
  if (packages !== undefined && packages !== null) {
    if (
      !Array.isArray(packages) ||
      !packages.every((entry): entry is string => typeof entry === 'string')
    )
      throw invalid('"packages" must be a list of strings');
    if (packages.length > limits.maxPatterns)
      throw new WorkspaceError(
        'WORKSPACE_LIMIT_EXCEEDED',
        `pnpm-workspace.yaml lists ${packages.length} patterns, more than the limit of ${limits.maxPatterns}`,
        ['pnpm-workspace.yaml'],
      );
    patterns = packages;
  }
  const link = value['linkWorkspacePackages'];
  if (link !== undefined && link !== true && link !== false && link !== 'deep')
    throw invalid('"linkWorkspacePackages" must be true, false or "deep"');
  return { patterns, linkWorkspacePackages: link };
}
