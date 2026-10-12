import { WorkspaceError } from './errors.js';
import {
  compileGlob,
  globMatches,
  globMayMatchBelow,
  textMatchesGlob,
  type GlobAlternative,
} from './glob.js';
import type { WorkspaceLimits } from './limits.js';
import type { WorkspaceTool } from './members.js';

/**
 * The patterns of a workspace declaration, compiled for the tool that reads
 * them. Both tools list member directories with positive globs and take some
 * away with `!`, and they differ where it matters:
 *
 * - npm applies a `!` in order: it is lifted again when a later pattern is
 *   itself matched by it, and it removes earlier patterns that it matches. It
 *   strips a leading `/` or `./`, so `/packages/*` means `packages/*`.
 * - pnpm applies every `!` to the whole list whatever its position. A leading
 *   `/` makes an absolute path that selects nothing in the workspace; `./` is
 *   dropped. The root is always a member when it has a manifest, and `.` or a
 *   pattern that only names the root adds nothing.
 *
 * Both skip `node_modules`, neither lets `*`, `?` or `**` match a name that
 * starts with ".", and both let `**` stand for zero directories, so
 * `packages/**` selects `packages` itself when it has a manifest.
 */
export interface WorkspacePatterns {
  readonly tool: WorkspaceTool;
  readonly declared: readonly string[];
  /** Whether the directory is selected: matched by a pattern and not taken away. */
  isMember(dir: readonly string[]): boolean;
  /** Whether a directory at or below `dir` could be selected, so the walk must go on. */
  mayHoldMembers(dir: readonly string[]): boolean;
  /**
   * Whether `dir` is named by the pattern itself and not found by searching a
   * `**`; the walk refuses a symbolic link there and passes over one found
   * while searching.
   */
  isExplicit(dir: readonly string[]): boolean;
  /**
   * Whether a pattern passes through `dir` by naming it, and not by searching:
   * `packages` in `packages/*` and in `packages/**`, but not `packages/x` in
   * `packages/**`. A link there would have to be followed to find the members
   * the pattern names, so the walk refuses it.
   */
  isExplicitPrefix(dir: readonly string[]): boolean;
}

interface Normalized {
  readonly negated: boolean;
  readonly text: string;
}

function normalizeNpm(raw: string): Normalized {
  let bangs = 0;
  while (raw[bangs] === '!') bangs += 1;
  const text = raw.slice(bangs).replace(/^\.?\/+/u, '');
  return { negated: bangs % 2 === 1, text };
}

function normalizePnpm(raw: string): Normalized {
  const negated = raw.startsWith('!');
  const body = negated ? raw.slice(1) : raw;
  if (body.startsWith('!') || body.startsWith('/'))
    throw new WorkspaceError(
      body.startsWith('/')
        ? 'WORKSPACE_PATTERN_ESCAPES_ROOT'
        : 'WORKSPACE_PATTERN_UNSUPPORTED',
      body.startsWith('/')
        ? `The workspace pattern ${JSON.stringify(raw)} is an absolute path; pnpm selects nothing with it`
        : `The workspace pattern ${JSON.stringify(raw)} negates twice, which pnpm does not define`,
      [raw],
    );
  return { negated, text: body.replace(/^\.\/+/u, '') };
}

/**
 * npm's `appendNegatedPatterns`, step for step, including the order it walks a
 * list it is also removing from: the second of two adjacent negations that a
 * later pattern lifts is left in place.
 */
function applyNpmNegations(
  entries: readonly Normalized[],
  limits: WorkspaceLimits,
) {
  let patterns: string[] = [];
  const negations: string[] = [];
  for (const entry of entries) {
    if (entry.negated) {
      negations.push(entry.text);
      continue;
    }
    for (let at = 0; at < negations.length; at += 1) {
      const negation = negations[at];
      if (
        negation !== undefined &&
        textMatchesGlob(entry.text, compileGlob(negation, limits))
      )
        negations.splice(at, 1);
    }
    patterns.push(entry.text);
  }
  for (const negation of negations) {
    const compiled = compileGlob(negation, limits);
    const matched = patterns.filter((pattern) =>
      textMatchesGlob(pattern, compiled),
    );
    for (const pattern of matched) {
      const at = patterns.indexOf(pattern);
      if (at !== -1)
        patterns = [...patterns.slice(0, at), ...patterns.slice(at + 1)];
    }
  }
  return { patterns, negations };
}

function compileAll(
  texts: readonly string[],
  tool: WorkspaceTool,
  limits: WorkspaceLimits,
): GlobAlternative[] {
  const compiled = texts.flatMap((text) => compileGlob(text, limits));
  const named = compiled.filter(
    (alternative) => alternative.segments.length > 0,
  );
  if (named.length !== compiled.length && tool === 'npm')
    throw new WorkspaceError(
      'WORKSPACE_PATTERN_INVALID',
      'A workspace pattern names the root itself; a root is not one of its own workspaces',
    );
  return named;
}

export function compileWorkspacePatterns(
  declared: readonly string[],
  tool: WorkspaceTool,
  limits: WorkspaceLimits,
): WorkspacePatterns {
  if (declared.length > limits.maxPatterns)
    throw new WorkspaceError(
      'WORKSPACE_LIMIT_EXCEEDED',
      `The workspace declares ${declared.length} patterns, more than the limit of ${limits.maxPatterns}`,
    );
  for (const raw of declared)
    if (raw === '' || raw.trim() === '')
      throw new WorkspaceError(
        'WORKSPACE_PATTERN_INVALID',
        'A workspace pattern is empty',
      );
  const entries = declared.map((raw) =>
    tool === 'npm' ? normalizeNpm(raw) : normalizePnpm(raw),
  );
  let positive: readonly string[];
  let negative: readonly string[];
  if (tool === 'npm') {
    const lifted = applyNpmNegations(entries, limits);
    positive = lifted.patterns;
    negative = lifted.negations;
  } else {
    positive = entries.filter((e) => !e.negated).map((e) => e.text);
    negative = entries.filter((e) => e.negated).map((e) => e.text);
  }
  const include = compileAll(positive, tool, limits);
  const exclude = compileAll(negative, tool, limits);
  if (include.length + exclude.length > limits.maxPatternAlternatives)
    throw new WorkspaceError(
      'WORKSPACE_LIMIT_EXCEEDED',
      `The workspace patterns expand to ${include.length + exclude.length} alternatives, more than the limit of ${limits.maxPatternAlternatives}`,
    );
  const selects = (dir: readonly string[]): boolean =>
    dir.length > 0 && !exclude.some((glob) => globMatches(glob, dir));
  return {
    tool,
    declared,
    isMember: (dir) =>
      selects(dir) && include.some((glob) => globMatches(glob, dir)),
    mayHoldMembers: (dir) =>
      include.some((glob) => globMayMatchBelow(glob, dir)),
    isExplicit: (dir) =>
      selects(dir) && include.some((glob) => globMatches(glob, dir, false)),
    isExplicitPrefix: (dir) =>
      include.some((glob) => globMayMatchBelow(glob, dir, false)),
  };
}
