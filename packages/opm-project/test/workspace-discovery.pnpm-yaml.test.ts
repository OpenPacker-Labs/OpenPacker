/**
 * Discovery reads `pnpm-workspace.yaml` on every pnpm install, before or after
 * the adapter does, so it holds the same line on cost: a repeated key is found
 * in linear time, nesting is refused before a document is built, and a tag is
 * refused rather than warned about on stderr.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverWorkspace } from '../src/index.js';
import { cleanup, refusal, scratch } from './workspace-tree.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('pnpm-workspace.yaml in discovery', () => {
  it('reads 40,000 catalog entries in linear time', async () => {
    const lines = ['packages: []', 'catalog:'];
    for (let index = 0; index < 40_000; index += 1)
      lines.push(`  pkg-${index}: ^1.0.${index}`);
    const root = await scratch({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': `${lines.join('\n')}\n`,
    });
    const started = performance.now();
    const found = await discoverWorkspace(root, { tool: 'pnpm' });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(found?.members.map((member) => member.dir)).toEqual(['']);
  }, 180_000);

  it('refuses a megabyte of [ before it builds a document', async () => {
    const started = performance.now();
    const error = await refusal({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': '['.repeat(1024 * 1024 - 1),
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(error.code).toBe('WORKSPACE_DECLARATION_INVALID');
    expect(error.message).toBe(
      'pnpm-workspace.yaml nests deeper than 64 levels',
    );
  }, 60_000);

  it('still refuses a key written twice, in a nested mapping too', async () => {
    const error = await refusal({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': 'packages: []\ncatalog:\n  a: ^1\n  a: ^2\n',
    });
    expect(error.code).toBe('WORKSPACE_DECLARATION_INVALID');
    expect(error.message).toMatch(/"a" is written twice in one mapping/u);
  });

  it('refuses a tag, and writes nothing to stderr', async () => {
    const warn = vi.spyOn(process, 'emitWarning');
    const error = await refusal({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml':
        'packages: []\noverrides:\n  a: !!js/function "function () {}"\n',
    });
    expect(error.code).toBe('WORKSPACE_DECLARATION_INVALID');
    expect(error.message).toMatch(/js\/function/u);
    expect(warn).not.toHaveBeenCalled();
  });
});
