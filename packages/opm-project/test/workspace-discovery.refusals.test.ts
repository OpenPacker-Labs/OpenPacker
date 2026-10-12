import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, dirsOf, npm, pnpm, refusal } from './workspace-tree.js';

afterEach(cleanup);

describe('refusals', () => {
  it('names both paths when two members have one name', async () => {
    const error = await refusal(
      npm(['p/*'], {
        'p/a/package.json': { name: 'same' },
        'p/b/package.json': { name: 'same' },
      }),
    );
    expect(error.code).toBe('WORKSPACE_NAME_DUPLICATE');
    expect(error.message).toBe(
      'Two workspace members are named "same": p/a and p/b',
    );
    expect(error.subjects).toEqual(['p/a', 'p/b']);
  });

  it('refuses a name that is not a package name', async () => {
    for (const name of ['../evil', 'has space', '.dot', 'a/b/c'])
      expect(
        (await refusal(npm(['p/*'], { 'p/a/package.json': { name } }))).code,
        name,
      ).toBe('WORKSPACE_NAME_INVALID');
  });

  it.each([
    ['../outside', 'WORKSPACE_PATTERN_ESCAPES_ROOT'],
    ['p/../../outside', 'WORKSPACE_PATTERN_ESCAPES_ROOT'],
    ['C:/x', 'WORKSPACE_PATTERN_ESCAPES_ROOT'],
    ['p/[ab]', 'WORKSPACE_PATTERN_UNSUPPORTED'],
    ['p/@(a|b)', 'WORKSPACE_PATTERN_UNSUPPORTED'],
    ['p\\a', 'WORKSPACE_PATTERN_UNSUPPORTED'],
    ['p/{a}', 'WORKSPACE_PATTERN_UNSUPPORTED'],
    ['', 'WORKSPACE_PATTERN_INVALID'],
  ])('refuses the pattern %j', async (pattern, code) => {
    expect((await refusal(npm([pattern]))).code).toBe(code);
    expect((await refusal(pnpm(`  - ${JSON.stringify(pattern)}\n`))).code).toBe(
      code,
    );
  });

  it('refuses an absolute pattern under pnpm and reads it as the root under npm', async () => {
    const files = { 'p/a/package.json': { name: 'a' } };
    expect((await refusal(pnpm('  - "/p/*"\n', files))).code).toBe(
      'WORKSPACE_PATTERN_ESCAPES_ROOT',
    );
    expect(await dirsOf(npm(['/p/*'], files))).toEqual(['', 'p/a']);
  });

  it('refuses a malformed declaration', async () => {
    expect(
      (await refusal({ 'package.json': { name: 'r', workspaces: 'p/*' } }))
        .code,
    ).toBe('WORKSPACE_DECLARATION_INVALID');
    expect(
      (await refusal({ 'package.json': { name: 'r', workspaces: [1] } })).code,
    ).toBe('WORKSPACE_DECLARATION_INVALID');
    for (const yaml of [
      'packages: nope\n',
      'packages:\n  - 1\n',
      '- a\n- b\n',
      'packages: [a\n',
      'packages: []\npackages: []\n',
      'linkWorkspacePackages: maybe\n',
      'a: 1\n---\nb: 2\n',
    ]) {
      const error = await refusal({
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': yaml,
      });
      expect(error.code, yaml).toBe('WORKSPACE_DECLARATION_INVALID');
    }
  });

  it('refuses an npm root with no package.json when workspaces are asked for', async () => {
    expect(
      await dirsOf(
        { 'pnpm-workspace.yaml': 'packages: [p]\n' },
        { tool: 'npm' },
      ),
    ).toBeUndefined();
  });

  it('refuses a manifest that is not strict JSON', async () => {
    const bad: [string, RegExp][] = [
      ['{"name":', /is not valid JSON/u],
      ['{"name":"a","name":"b"}', /lists the key "name" twice/u],
      [
        '{"name":"a","dependencies":{"x":"1","x":"2"}}',
        /lists the key "x" twice/u,
      ],
      ['[]', /must be a JSON object/u],
      ['{"name":"a","version":"1.0"}', /not a semantic version/u],
      ['{"name":"a","dependencies":{"x":1}}', /must be a string specifier/u],
      ['\u00ff\u00fe', /not valid/u],
    ];
    for (const [text, problem] of bad) {
      const error = await refusal(npm(['p/*'], { 'p/a/package.json': text }));
      expect(error.code, text).toMatch(/^WORKSPACE_MANIFEST_INVALID$/u);
      expect(error.message, text).toMatch(problem);
      expect(error.message, text).toContain('p/a/package.json');
    }
    const binary = await refusal(
      npm(['p/*'], {
        'p/a/package.json': Buffer.from([0x7b, 0xc3, 0x28, 0x7d]).toString(
          'latin1',
        ),
      }),
    );
    expect(binary.code).toBe('WORKSPACE_MANIFEST_INVALID');
  });

  it('refuses a root manifest that is not strict JSON, naming it', async () => {
    const error = await refusal({
      'package.json': '{"workspaces":["a"],"workspaces":[]}',
    });
    expect(error.code).toBe('WORKSPACE_MANIFEST_INVALID');
    expect(error.message).toContain(
      'package.json lists the key "workspaces" twice',
    );
  });

  it('refuses a package.yaml a pnpm member has instead of a package.json', async () => {
    const error = await refusal(
      pnpm('  - "p/*"\n', { 'p/a/package.yaml': 'name: a\n' }),
    );
    expect(error.code).toBe('WORKSPACE_MANIFEST_INVALID');
    expect(error.message).toContain(
      'p/a has a package.yaml and no package.json',
    );
    // npm does not read package.yaml at all, and that is not an error there.
    expect(
      await dirsOf(npm(['p/*'], { 'p/a/package.yaml': 'name: a\n' })),
    ).toEqual(['']);
  });
});
