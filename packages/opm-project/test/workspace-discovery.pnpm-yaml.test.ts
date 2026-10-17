/**
 * Discovery reads `pnpm-workspace.yaml` on every pnpm install, before or after
 * the adapter does, so it holds the same line on cost: a repeated key is found
 * in linear time, nesting is refused before a document is built, and a tag is
 * refused rather than warned about on stderr.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_LIMITS } from '@openpacker/adapter-core';
import { discoverWorkspace } from '../src/index.js';
import { parsePnpmWorkspaceYaml } from '../src/workspace/declaration.js';
import { cleanup, refusal, scratch } from './workspace-tree.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('pnpm-workspace.yaml in discovery', () => {
  it('reads 40,000 catalog entries in linear time', async () => {
    const declaration = (entries: number) => {
      const lines = ['packages: []', 'catalog:'];
      for (let index = 0; index < entries; index += 1)
        lines.push(`  pkg-${index}: ^1.0.${index}`);
      return `${lines.join('\n')}\n`;
    };
    // Counted, not timed (a 5 s bound failed on a loaded machine). The cost was
    // the library's repeated-key check, which compares each key with every
    // earlier one (13 s here). It is off where discovery parses: a repeated
    // key is `firstRepeatedKey`'s refusal, which the library's would pre-empt.
    expect(() =>
      parsePnpmWorkspaceYaml(
        'catalog:\n  a: ^1\n  a: ^2\n',
        DEFAULT_WORKSPACE_LIMITS,
      ),
    ).toThrow(/has the duplicate key "a"/u);
    const meter = { keyLookups: 0 };
    parsePnpmWorkspaceYaml(
      declaration(40_000),
      DEFAULT_WORKSPACE_LIMITS,
      meter,
    );
    expect(meter.keyLookups).toBe(40_002);
    const root = await scratch({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': declaration(40_000),
    });
    const found = await discoverWorkspace(root, { tool: 'pnpm' });
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
    expect(error.message).toMatch(/has the duplicate key "a" in one mapping/u);
  });

  it('refuses 1 beside "1" as a duplicate key, as pnpm does', async () => {
    const error = await refusal({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': 'packages: []\ncatalog:\n  1: ^1\n  "1": ^2\n',
    });
    expect(error.code).toBe('WORKSPACE_DECLARATION_INVALID');
    expect(error.message).toBe(
      'pnpm-workspace.yaml has the duplicate key "1" in one mapping (a key is compared as text, as pnpm compares it, so 1 and "1" are one key)',
    );
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
