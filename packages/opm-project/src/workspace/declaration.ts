import type { JsonValue } from '@openpacker/contracts';
import { WorkspaceError, type WorkspaceLimits } from '@openpacker/adapter-core';
import { parseDocument } from 'yaml';

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
  const document = parseDocument(text, {
    version: '1.2',
    uniqueKeys: true,
    prettyErrors: false,
  });
  const failure = document.errors[0];
  if (failure !== undefined)
    throw invalid(`is not valid YAML: ${failure.message.split('\n')[0]}`);
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
