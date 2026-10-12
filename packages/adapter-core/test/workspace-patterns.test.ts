import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceError,
  compileWorkspacePatterns,
  expandBraces,
  globMatches,
  globMayMatchBelow,
  compileGlob,
  type WorkspaceErrorCode,
  type WorkspaceTool,
} from '../src/index.js';

/**
 * The golden file was produced by running the two tools themselves over one
 * directory tree: pnpm 10.28.0's `findPackages` (tinyglobby 0.2.14, the root
 * always included, `node_modules` ignored) and npm 10.9.4's
 * `@npmcli/map-workspaces` 4.0.2 (glob 10). Each case is a pattern list and the
 * member directories each tool selected. The cases the model refuses on
 * purpose are the ones in REFUSED, with the reason.
 */
interface Battery {
  manifests: string[];
  bare: string[];
  cases: { patterns: string[]; pnpm: string[]; npm: string[] }[];
}

const battery: Battery = JSON.parse(
  readFileSync(
    new URL('./fixtures/workspace-glob-oracle.json', import.meta.url),
    'utf8',
  ),
);

/**
 * The pattern lists on which pnpm's globber (tinyglobby 0.2.14) is the odd one
 * out, with the rule; the model keeps to what npm and the plain reading of
 * "zero or more directories" give. See the ADR's list of differences.
 */
const known: { pnpmHiddenAfterGlobstar: { rule: string; lists: string[][] } } =
  JSON.parse(
    readFileSync(
      new URL(
        './fixtures/workspace-glob-known-differences.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
const HIDDEN_AFTER_GLOBSTAR = new Set(
  known.pnpmHiddenAfterGlobstar.lists.map((list) => JSON.stringify(list)),
);

const REFUSED: readonly {
  patterns: string[];
  tool: WorkspaceTool | 'both';
  code: WorkspaceErrorCode;
}[] = [
  // pnpm reads a leading "/" as an absolute path and selects nothing; npm reads it as the root.
  {
    patterns: ['/packages/*'],
    tool: 'pnpm',
    code: 'WORKSPACE_PATTERN_ESCAPES_ROOT',
  },
  {
    patterns: ['packages/*', '!/packages/b'],
    tool: 'pnpm',
    code: 'WORKSPACE_PATTERN_ESCAPES_ROOT',
  },
  {
    patterns: ['packages/*', '!!packages/b'],
    tool: 'pnpm',
    code: 'WORKSPACE_PATTERN_UNSUPPORTED',
  },
  // npm selects nothing for a "." segment in the middle of a path; pnpm drops it.
  {
    patterns: ['packages/./a'],
    tool: 'both',
    code: 'WORKSPACE_PATTERN_INVALID',
  },
  {
    patterns: ['./packages/./a'],
    tool: 'both',
    code: 'WORKSPACE_PATTERN_INVALID',
  },
  {
    patterns: ['packages/a/.'],
    tool: 'both',
    code: 'WORKSPACE_PATTERN_INVALID',
  },
  {
    patterns: ['packages/*/.'],
    tool: 'both',
    code: 'WORKSPACE_PATTERN_INVALID',
  },
];

function refusal(patterns: string[], tool: WorkspaceTool) {
  return REFUSED.find(
    (entry) =>
      JSON.stringify(entry.patterns) === JSON.stringify(patterns) &&
      (entry.tool === tool || entry.tool === 'both'),
  );
}

function directories(): string[][] {
  const all = new Set<string>();
  for (const dir of [...battery.manifests, ...battery.bare]) {
    const parts = dir.split('/').filter((part) => part !== '');
    for (let at = 1; at <= parts.length; at += 1)
      all.add(parts.slice(0, at).join('/'));
  }
  return [...all].sort().map((dir) => dir.split('/'));
}

function selected(patterns: string[], tool: WorkspaceTool): string[] {
  const compiled = compileWorkspacePatterns(
    patterns,
    tool,
    DEFAULT_WORKSPACE_LIMITS,
  );
  const members = battery.manifests
    .filter((dir) => dir !== '')
    .filter((dir) => compiled.isMember(dir.split('/')));
  if (tool === 'pnpm' && battery.manifests.includes('')) members.push('');
  return members.sort();
}

describe('workspace patterns against the tools themselves', () => {
  for (const tool of ['pnpm', 'npm'] as const) {
    describe(tool, () => {
      for (const entry of battery.cases) {
        const label = JSON.stringify(entry.patterns);
        const refused = refusal(entry.patterns, tool);
        if (refused !== undefined) {
          it(`${label} is refused as ${refused.code}`, () => {
            expect(() =>
              compileWorkspacePatterns(
                entry.patterns,
                tool,
                DEFAULT_WORKSPACE_LIMITS,
              ),
            ).toThrowError(
              expect.objectContaining({ code: refused.code }) as Error,
            );
          });
          continue;
        }
        if (tool === 'pnpm' && HIDDEN_AFTER_GLOBSTAR.has(label)) {
          it(`${label} selects what npm selects, where pnpm drops a hidden directory after **`, () => {
            // The pinned choice: npm's answer (pnpm keeps the root, npm never lists it).
            const chosen = selected(entry.patterns, tool);
            expect(chosen).toEqual(['', ...entry.npm].sort());
            // And pnpm's record really does differ, or this is not a known difference at all.
            expect(chosen).not.toEqual([...entry.pnpm].sort());
          });
        } else
          it(`${label} selects what ${tool} selects`, () => {
            expect(selected(entry.patterns, tool)).toEqual(
              [...entry[tool]].sort(),
            );
          });
        it(`${label} is reachable by descent`, () => {
          const compiled = compileWorkspacePatterns(
            entry.patterns,
            tool,
            DEFAULT_WORKSPACE_LIMITS,
          );
          for (const dir of selected(entry.patterns, tool)) {
            if (dir === '') continue;
            const parts = dir.split('/');
            for (let at = 0; at < parts.length; at += 1)
              expect(
                compiled.mayHoldMembers(parts.slice(0, at)),
                `descent stops at ${parts.slice(0, at).join('/') || '(root)'} on the way to ${dir}`,
              ).toBe(true);
          }
        });
      }
    });
  }

  it('lists every directory the golden tree names', () => {
    expect(directories().length).toBeGreaterThan(30);
  });
});

describe('workspace glob dialect', () => {
  const limits = DEFAULT_WORKSPACE_LIMITS;
  const matches = (pattern: string, path: string) =>
    compileGlob(pattern, limits).some((glob) =>
      globMatches(glob, path.split('/').filter(Boolean)),
    );

  it('lets a star stand for any run of characters inside one name', () => {
    expect(matches('packages/*', 'packages/a')).toBe(true);
    expect(matches('packages/*', 'packages/a/b')).toBe(false);
    expect(matches('packages/pack-*', 'packages/pack-x')).toBe(true);
    expect(matches('packages/*-x', 'packages/pack-x')).toBe(true);
    expect(matches('packages/*a*', 'packages/Cap')).toBe(true);
    expect(matches('packages/*a*', 'packages/b')).toBe(false);
  });

  it('lets a question mark stand for exactly one character', () => {
    expect(matches('packages/?', 'packages/a')).toBe(true);
    expect(matches('packages/?', 'packages/ab')).toBe(false);
    expect(matches('packages/a?', 'packages/a1')).toBe(true);
  });

  it('lets a globstar stand for zero or more directories', () => {
    expect(matches('packages/**', 'packages')).toBe(true);
    expect(matches('packages/**', 'packages/a/b/c')).toBe(true);
    expect(matches('**/e', 'packages/c/d/e')).toBe(true);
    expect(matches('**/e', 'e')).toBe(true);
    expect(matches('packages/**/sub', 'packages/b/sub')).toBe(true);
  });

  it('keeps a wildcard off names that start with a dot, and a literal dot on', () => {
    expect(matches('packages/*', 'packages/.hid')).toBe(false);
    expect(matches('packages/?hid', 'packages/.hid')).toBe(false);
    expect(matches('packages/**', 'packages/.hid/x')).toBe(false);
    expect(matches('packages/.hid', 'packages/.hid')).toBe(true);
    expect(matches('packages/.*', 'packages/.hid')).toBe(true);
  });

  it('never matches node_modules, however it is asked for', () => {
    expect(matches('**', 'packages/nm/node_modules/zz')).toBe(false);
    expect(
      matches('packages/nm/node_modules/zz', 'packages/nm/node_modules/zz'),
    ).toBe(false);
    expect(matches('packages/*/node_modules', 'packages/nm/node_modules')).toBe(
      false,
    );
  });

  it('expands braces, nested, across slashes, and with an empty choice', () => {
    expect(expandBraces('p/{a,b}', 16)).toEqual(['p/a', 'p/b']);
    expect(expandBraces('{p,q}/{a,b}', 16)).toEqual([
      'p/a',
      'p/b',
      'q/a',
      'q/b',
    ]);
    expect(expandBraces('p/{a,b/c}', 16)).toEqual(['p/a', 'p/b/c']);
    expect(expandBraces('p/{a,{b,c}}', 16)).toEqual(['p/a', 'p/b', 'p/c']);
    expect(expandBraces('p/{a,}', 16)).toEqual(['p/a', 'p/']);
  });

  it('refuses what it would read differently from the tools', () => {
    const code = (pattern: string): string | undefined => {
      try {
        compileGlob(pattern, limits);
        return undefined;
      } catch (error) {
        return error instanceof WorkspaceError ? error.code : 'other';
      }
    };
    for (const pattern of [
      'packages/[ab]',
      'packages/@(a|b)',
      'packages/+(a)',
      'packages/!(a)',
      'packages/a\\b',
      'packages/{a}',
      'packages/{1..3}',
    ])
      expect(code(pattern), pattern).toBe('WORKSPACE_PATTERN_UNSUPPORTED');
    for (const pattern of ['../x', 'packages/../../x', 'C:/x'])
      expect(code(pattern), pattern).toBe('WORKSPACE_PATTERN_ESCAPES_ROOT');
    expect(code('packages/{a')).toBe('WORKSPACE_PATTERN_INVALID');
    expect(code('packages/a}')).toBe('WORKSPACE_PATTERN_INVALID');
    expect(code('packages/a\u0000')).toBe('WORKSPACE_PATTERN_INVALID');
  });

  it('refuses a pattern that names the root under npm, and drops it under pnpm', () => {
    for (const patterns of [['.'], ['{.,p}'], ['p/*', '.']]) {
      const run = (tool: WorkspaceTool) => () =>
        compileWorkspacePatterns(patterns, tool, limits);
      expect(run('npm'), JSON.stringify(patterns)).toThrowError(
        expect.objectContaining({
          code: 'WORKSPACE_PATTERN_INVALID',
          message: expect.stringContaining('names the root itself') as string,
        }) as Error,
      );
      expect(run('pnpm'), JSON.stringify(patterns)).not.toThrow();
    }
    // Under pnpm it adds nothing: the root is always a member, and p/* still works.
    const compiled = compileWorkspacePatterns(['p/*', '.'], 'pnpm', limits);
    expect(compiled.isMember(['p', 'a'])).toBe(true);
    expect(compiled.isMember([])).toBe(false);
  });

  it('bounds a pattern: its length and what its braces expand to', () => {
    expect(() => compileGlob('a'.repeat(1025), limits)).toThrowError(
      /1025 characters long, more than the limit of 1024/u,
    );
    const braces = Array.from({ length: 9 }, () => '{a,b}').join('');
    expect(() => compileGlob(braces, limits)).toThrowError(
      /expands to more than 256 alternatives/u,
    );
  });

  it('bounds a declaration: what all its patterns expand to, together', () => {
    const patterns = Array.from(
      { length: 30 },
      (_, at) => `p${at}/{a,b,c}{d,e,f}`,
    );
    expect(() =>
      compileWorkspacePatterns(patterns, 'pnpm', limits),
    ).toThrowError(/expand to 270 alternatives, more than the limit of 256/u);
    expect(() =>
      compileWorkspacePatterns(patterns.slice(0, 20), 'pnpm', limits),
    ).not.toThrow();
  });

  it('matches in time proportional to the name, whatever the pattern', () => {
    const pattern = `${'*a'.repeat(30)}*b`;
    const name = 'a'.repeat(250);
    const [glob] = compileGlob(pattern, limits);
    const started = performance.now();
    expect(globMatches(glob!, [name])).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('tells where a descent can stop', () => {
    const [glob] = compileGlob('packages/*', limits);
    expect(globMayMatchBelow(glob!, [])).toBe(true);
    expect(globMayMatchBelow(glob!, ['packages'])).toBe(true);
    expect(globMayMatchBelow(glob!, ['packages', 'a'])).toBe(false);
    expect(globMayMatchBelow(glob!, ['tools'])).toBe(false);
    const [deep] = compileGlob('packages/**', limits);
    expect(globMayMatchBelow(deep!, ['packages', 'a', 'b'])).toBe(true);
  });
});
