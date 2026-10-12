import { WorkspaceError } from './errors.js';

/**
 * Bounds on everything a workspace can make the model do. A repository is
 * input: a glob that matches a million directories, a `package.json` the size
 * of a disk and a tree a thousand levels deep must end in a refusal that names
 * the bound, never in memory exhaustion.
 */
export interface WorkspaceLimits {
  /** Most members (the root included) one workspace may have. */
  readonly maxMembers: number;
  /** Most directory entries read, counted over every directory visited. */
  readonly maxDirectoryEntries: number;
  /** Deepest directory below the root that is visited. */
  readonly maxDepth: number;
  /** Most patterns one declaration may list. */
  readonly maxPatterns: number;
  /** Longest single pattern, in UTF-16 code units. */
  readonly maxPatternLength: number;
  /**
   * Most alternatives a whole declaration may expand to through `{a,b}`. Every
   * directory the walk visits is matched against each of them.
   */
  readonly maxPatternAlternatives: number;
  /** Largest `package.json`, in bytes. */
  readonly maxManifestBytes: number;
  /** Most bytes of `package.json` held at once, over every member. */
  readonly maxTotalManifestBytes: number;
  /** Largest `pnpm-workspace.yaml`, in bytes. */
  readonly maxDeclarationBytes: number;
  /** Most entries in one dependency list of one manifest. */
  readonly maxDependencyEntries: number;
}

/**
 * HoBo, the largest workspace measured when these were set, has 792 members
 * (its lock lists 792 importers), reads about 3,000 directory entries and
 * keeps every manifest under 20 KiB. The defaults leave room above that by a
 * factor of five or more and stop a runaway long before it matters.
 */
export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = Object.freeze({
  maxMembers: 4096,
  maxDirectoryEntries: 100_000,
  maxDepth: 32,
  maxPatterns: 256,
  maxPatternLength: 1024,
  maxPatternAlternatives: 256,
  maxManifestBytes: 1024 * 1024,
  maxTotalManifestBytes: 64 * 1024 * 1024,
  maxDeclarationBytes: 1024 * 1024,
  maxDependencyEntries: 10_000,
});

/** A limit may be raised, but not past these; they are not configurable. */
const CEILINGS: WorkspaceLimits = Object.freeze({
  maxMembers: 100_000,
  maxDirectoryEntries: 10_000_000,
  maxDepth: 128,
  maxPatterns: 4096,
  maxPatternLength: 8192,
  maxPatternAlternatives: 4096,
  maxManifestBytes: 64 * 1024 * 1024,
  maxTotalManifestBytes: 1024 * 1024 * 1024,
  maxDeclarationBytes: 16 * 1024 * 1024,
  maxDependencyEntries: 1_000_000,
});

const LIMIT_NAMES = Object.keys(
  DEFAULT_WORKSPACE_LIMITS,
) as readonly (keyof WorkspaceLimits)[];

export function resolveWorkspaceLimits(
  overrides: Partial<WorkspaceLimits> = {},
): WorkspaceLimits {
  const resolved = { ...DEFAULT_WORKSPACE_LIMITS };
  for (const name of LIMIT_NAMES) {
    const value = overrides[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > CEILINGS[name])
      throw new WorkspaceError(
        'WORKSPACE_LIMIT_EXCEEDED',
        `The workspace limit ${name} must be an integer from 1 to ${CEILINGS[name]}, received ${String(value)}`,
      );
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}
