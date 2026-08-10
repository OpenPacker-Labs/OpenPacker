import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applySpanEdits,
  detectJsonStyle,
  editJsonFile,
  matchFileStyle,
  ProjectIoError,
  readTextFile,
  writeFileAtomic,
} from './index.js';

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'project-io-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('editJsonFile', () => {
  it('keeps the indentation the file already used', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'package.json');
      await writeFile(
        path,
        '{\n    "name": "demo",\n    "version": "1.0.0"\n}\n',
      );
      await editJsonFile<Record<string, unknown>>(path, (value) => {
        value.dependencies = { chalk: '^4.1.2' };
      });
      const text = await readFile(path, 'utf8');
      // Four spaces, because that is what was there.
      expect(text).toContain('\n    "dependencies": {');
      expect(text).toContain('\n        "chalk": "^4.1.2"');
      expect(text.endsWith('\n')).toBe(true);
    });
  });

  it('preserves CRLF line endings', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'package.json');
      await writeFile(path, '{\r\n  "name": "demo"\r\n}\r\n');
      await editJsonFile<Record<string, unknown>>(path, (value) => {
        value.version = '2.0.0';
      });
      const text = await readFile(path, 'utf8');
      expect(text.includes('\r\n')).toBe(true);
      expect(/[^\r]\n/u.test(text)).toBe(false);
    });
  });

  it('reports no change rather than rewriting an identical file', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'package.json');
      await writeFile(path, '{\n  "name": "demo"\n}\n');
      const result = await editJsonFile<Record<string, unknown>>(
        path,
        (value) => {
          value.name = 'demo';
        },
      );
      expect(result.changed).toBe(false);
    });
  });

  it('refuses a file that is mid-merge', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'package.json');
      await writeFile(
        path,
        '{\n<<<<<<< HEAD\n  "name": "ours"\n=======\n  "name": "theirs"\n>>>>>>> branch\n}\n',
      );
      await expect(readTextFile(path)).rejects.toBeInstanceOf(ProjectIoError);
      await expect(editJsonFile(path, (value) => value)).rejects.toMatchObject({
        code: 'CONFLICTED_FILE',
      });
    });
  });

  it('leaves the original in place when the edit throws', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'package.json');
      await writeFile(path, '{ not json');
      await expect(editJsonFile(path, (value) => value)).rejects.toMatchObject({
        code: 'INVALID_JSON',
      });
      expect(await readFile(path, 'utf8')).toBe('{ not json');
    });
  });
});

describe('writeFileAtomic', () => {
  it('leaves no temporary file behind', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'nested', 'out.txt');
      await writeFileAtomic(path, 'hello');
      expect(await readFile(path, 'utf8')).toBe('hello');
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(join(dir, 'nested'))).toEqual(['out.txt']);
    });
  });
});

describe('detectJsonStyle', () => {
  it('reads tabs and spaces, and falls back to two spaces', () => {
    expect(detectJsonStyle('{\n\t"a": 1\n}').indent).toBe('\t');
    expect(detectJsonStyle('{\n    "a": 1\n}').indent).toBe('    ');
    expect(detectJsonStyle('{"a":1}').indent).toBe('  ');
  });
});

describe('matchFileStyle', () => {
  it('restores the absence of a trailing newline', () => {
    const file = {
      path: 'x',
      text: '{}',
      newline: '\n' as const,
      trailingNewline: false,
    };
    expect(matchFileStyle(file, '{}\n')).toBe('{}');
  });
});

describe('applySpanEdits', () => {
  it('applies right to left so offsets stay valid', () => {
    expect(
      applySpanEdits('abcdef', [
        { start: 1, end: 2, replacement: 'BB' },
        { start: 4, end: 5, replacement: 'EE' },
      ]),
    ).toBe('aBBcdEEf');
  });

  it('refuses overlapping or out-of-range edits', () => {
    expect(() =>
      applySpanEdits('abc', [
        { start: 0, end: 2, replacement: 'x' },
        { start: 1, end: 3, replacement: 'y' },
      ]),
    ).toThrow(/overlap/u);
    expect(() =>
      applySpanEdits('abc', [{ start: 0, end: 9, replacement: 'x' }]),
    ).toThrow(/out of bounds/u);
  });
});
