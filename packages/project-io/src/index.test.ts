import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applySpanEdits,
  collectFiles,
  collectFilesFromHandle,
  detectJsonStyle,
  editJsonFile,
  editTomlArray,
  editTomlTable,
  findExecutable,
  matchFileStyle,
  ProjectIoError,
  handlePathForPlatform,
  openStableDirectory,
  readTextFile,
  removeTree,
  supportsStableTreeLayout,
  windowsNtHandlePathForm,
  writeFileAtomic,
} from './index.js';

describe('stable tree collection', () => {
  it('keeps reading the authorized tree after its pathname is replaced', async () => {
    await withTemp(async (dir) => {
      const tree = join(dir, 'tree');
      const original = join(dir, 'original');
      await mkdir(tree);
      await writeFile(join(tree, 'value'), 'authorized');
      const handle = await openStableDirectory(tree);
      try {
        await rename(tree, original);
        await mkdir(tree);
        await writeFile(join(tree, 'value'), 'replacement');
        const files = await collectFilesFromHandle(handle);
        expect(new TextDecoder().decode(files[0]?.contents)).toBe('authorized');
      } finally {
        await handle.close();
      }
    });
  });
});

describe('findExecutable', () => {
  it('resolves a PATH binary without executing it', async () => {
    await withTemp(async (dir) => {
      const tool = join(dir, 'native');
      const marker = join(dir, 'executed');
      await writeFile(tool, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(tool, 0o755);
      expect(await findExecutable('native', { PATH: dir, PATHEXT: '' })).toBe(
        tool,
      );
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

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

  it('does not follow a linked output ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-io-linked-'));
    const outside = await mkdtemp(join(tmpdir(), 'project-io-outside-'));
    try {
      await symlink(outside, join(root, '.opm'), 'dir');
      await expect(
        writeFileAtomic(join(root, '.opm', 'pack', 'artifact'), 'blocked'),
      ).rejects.toThrow();
      await expect(
        readFile(join(outside, 'pack', 'artifact')),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
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

describe('materialiseTree', () => {
  it('advertises stable fd-relative traversal on linux, darwin, and win32', () => {
    expect(supportsStableTreeLayout('linux')).toBe(true);
    expect(supportsStableTreeLayout('darwin')).toBe(true);
    expect(supportsStableTreeLayout('win32')).toBe(true);
    expect(handlePathForPlatform(4, 'win32')).toBe(windowsNtHandlePathForm(4));
    expect(() => handlePathForPlatform(4, 'win32')).not.toThrow(
      /unavailable on this platform/i,
    );
    expect(() => handlePathForPlatform(4, 'aix')).toThrow(
      /unavailable on this platform/i,
    );
  });

  it('fails closed on win32 without the NT runtime instead of re-walking paths', async () => {
    // This host is Linux, so the NT handle mapping cannot complete: every
    // child operation must throw (koffi/ntdll unavailable), never fall back
    // to a lexical pathname open. The win32 branch is spoofed through
    // process.platform, which the helpers read at call time.
    const {
      lstatChild,
      mkdirChild,
      mkdtempChild,
      openChild,
      readDirChild,
      readDirChildWithTypes,
      removeChild,
      renameChild,
      stableHandlePath,
      StableHandleError,
    } = await import('./index.js');
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const parent = {
        fd: -1,
      } as import('node:fs/promises').FileHandle;
      expect(() => stableHandlePath(parent)).toThrow(StableHandleError);
      await expect(openChild(parent, 'x', 0)).rejects.toThrow();
      await expect(mkdirChild(parent, 'x')).rejects.toThrow();
      await expect(mkdtempChild(parent, 'x-')).rejects.toThrow();
      await expect(renameChild(parent, 'a', 'b')).rejects.toThrow();
      await expect(removeChild(parent, 'x')).rejects.toThrow();
      await expect(lstatChild(parent, 'x')).rejects.toThrow();
      await expect(readDirChild(parent)).rejects.toThrow();
      await expect(readDirChildWithTypes(parent)).rejects.toThrow();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('refuses a destination outside its root', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const root = join(dir, 'node_modules');
      // A package name is registry-controlled and this path is followed by a
      // recursive delete.
      await expect(
        materialiseTree(dir, join(root, '..', '..', 'escaped'), root),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it.each(['root', 'scope'])('refuses a linked %s ancestor', async (kind) => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'node_modules');
      const outside = join(dir, 'outside');
      await mkdir(source);
      await writeFile(join(source, 'package.js'), 'safe');
      await mkdir(outside);
      await writeFile(join(outside, 'marker'), 'untouched');
      if (kind === 'root') await symlink(outside, root, 'dir');
      else {
        await mkdir(root);
        await symlink(outside, join(root, '@scope'), 'dir');
      }
      const destination =
        kind === 'root' ? join(root, 'pkg') : join(root, '@scope', 'pkg');
      await expect(
        materialiseTree(source, destination, root),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('untouched');
      await expect(readFile(join(outside, 'package.js'))).rejects.toThrow();
    });
  });

  it('materialises through a symlinked ancestor of the root', async () => {
    // Stock macOS symlinks /var → /private/var, so every $TMPDIR tree has a
    // symlinked ancestor; the same holds for symlinked home directories and
    // automounters on Linux. The prefix is canonicalized once, then all
    // traversal is fd-relative, so a later swap cannot redirect anything.
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const real = join(dir, 'real');
      const source = join(real, 'source');
      const root = join(real, 'node_modules');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'package.js'), 'safe');
      const alias = join(dir, 'alias');
      await symlink(real, alias, 'dir');

      const result = await materialiseTree(
        join(alias, 'source'),
        join(alias, 'node_modules', 'pkg'),
        join(alias, 'node_modules'),
      );
      expect(result.files).toBe(1);
      expect(await readFile(join(root, 'pkg', 'package.js'), 'utf8')).toBe(
        'safe',
      );
    });
  });

  it('refuses a linked ancestor when removing a tree', async () => {
    await withTemp(async (dir) => {
      const outside = join(dir, 'outside');
      const linked = join(dir, 'linked');
      await mkdir(join(outside, 'victim'), { recursive: true });
      await writeFile(join(outside, 'victim', 'marker'), 'untouched');
      await symlink(outside, linked, 'dir');

      await expect(removeTree(join(linked, 'victim'))).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      expect(await readFile(join(outside, 'victim', 'marker'), 'utf8')).toBe(
        'untouched',
      );
    });
  });

  it('replaces the destination instead of merging into it', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const { mkdir } = await import('node:fs/promises');
      const source = join(dir, 'src');
      const destination = join(dir, 'out', 'pkg');
      await mkdir(join(source, 'lib'), { recursive: true });
      await writeFile(join(source, 'lib', 'a.js'), 'a');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'stale.js'), 'stale');

      const result = await materialiseTree(
        source,
        destination,
        join(dir, 'out'),
      );
      expect(result.files).toBe(1);
      expect(await readFile(join(destination, 'lib', 'a.js'), 'utf8')).toBe(
        'a',
      );
      await expect(
        readFile(join(destination, 'stale.js'), 'utf8'),
      ).rejects.toThrow();
    });
  });

  it('refuses source files changed while they are copied', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const file = join(source, 'large.bin');
      await mkdir(source);
      await writeFile(file, new Uint8Array(16 * 1024 * 1024));
      const changing = await open(file, 'r+');
      let running = true;
      let revision = 0;
      const mutate = (async () => {
        while (running) {
          await changing.write(Uint8Array.of(revision++ & 0xff), 0, 1, 0);
          await changing.sync();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      try {
        await expect(
          materialiseTree(source, join(root, 'pkg'), root),
        ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      } finally {
        running = false;
        await mutate;
        await changing.close();
      }
    });
  });

  it('refuses source directory entries added after enumeration', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      await mkdir(source);
      await writeFile(
        join(source, 'large.bin'),
        new Uint8Array(16 * 1024 * 1024),
      );
      const materialising = materialiseTree(source, join(root, 'pkg'), root);
      void materialising.catch(() => undefined);
      let stagedFile: string | undefined;
      while (stagedFile === undefined) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const staging = (await readdir(root).catch(() => [] as string[])).find(
          (entry) => entry.startsWith('.pkg.openpacker-'),
        );
        if (staging) {
          const candidate = join(root, staging, 'large.bin');
          if (await lstat(candidate).catch(() => undefined))
            stagedFile = candidate;
        }
        if (stagedFile === undefined)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await writeFile(join(source, 'late.js'), 'not part of a stable input');
      await expect(materialising).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
    });
  });

  it('refuses entries added to staging before publication', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const destination = join(root, 'pkg');
      await mkdir(source);
      await writeFile(
        join(source, 'large.bin'),
        new Uint8Array(16 * 1024 * 1024),
      );
      const materialising = materialiseTree(source, destination, root);
      void materialising.catch(() => undefined);
      let staging: string | undefined;
      while (staging === undefined) {
        const candidate =
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          (await readdir(root).catch(() => [] as string[])).find((entry) =>
            entry.startsWith('.pkg.openpacker-'),
          );
        if (
          candidate &&
          (await lstat(join(root, candidate, 'large.bin')).catch(
            () => undefined,
          ))
        )
          staging = candidate;
        if (staging === undefined)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await writeFile(join(root, staging, 'attacker'), 'not copied');
      await expect(materialising).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      await expect(lstat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('rechecks staging after removing the previous destination', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const destination = join(root, 'pkg');
      const old = join(destination, 'old');
      await mkdir(source);
      await mkdir(old, { recursive: true });
      await writeFile(
        join(source, 'large.bin'),
        new Uint8Array(4 * 1024 * 1024),
      );
      const oldCount = 2_000;
      await Promise.all(
        Array.from({ length: oldCount }, async (_, index) =>
          writeFile(join(old, String(index)), 'old'),
        ),
      );

      let settled = false;
      const materialising = materialiseTree(source, destination, root);
      void materialising.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let mutated = false;
      while (!settled && !mutated) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const staging = (await readdir(root).catch(() => [] as string[])).find(
          (entry) => entry.startsWith('.pkg.openpacker-'),
        );
        if (staging) {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          const remaining = await readdir(old).catch(() => [] as string[]);
          if (remaining.length < oldCount) {
            await writeFile(join(root, staging, 'attacker'), 'late mutation');
            mutated = true;
          }
        }
        if (!mutated)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(mutated).toBe(true);
      await expect(materialising).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
    });
  });

  it('refuses a substituted staging directory before publication', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const destination = join(root, 'pkg');
      await mkdir(source);
      await writeFile(
        join(source, 'large.bin'),
        new Uint8Array(16 * 1024 * 1024),
      );

      let settled = false;
      const materialising = materialiseTree(source, destination, root);
      void materialising.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let staging: string | undefined;
      while (!settled && staging === undefined) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const entries = await readdir(root).catch(() => [] as string[]);
        staging = entries.find((entry) => entry.startsWith('.pkg.openpacker-'));
        if (staging === undefined)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(staging).toBeDefined();
      const stagedPath = join(root, staging!);
      // Wait until the copy has started so the substitution races the open
      // staging handle, not a directory that does not exist yet.
      while (!settled) {
        if (await lstat(join(stagedPath, 'large.bin')).catch(() => undefined))
          break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await rename(stagedPath, `${stagedPath}.original`);
      await mkdir(stagedPath);
      await writeFile(join(stagedPath, 'attacker'), 'not published');

      await expect(materialising).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      await expect(lstat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });
});

describe('TOML and tree helpers', () => {
  it('edits tables and owned array entries without disturbing foreign data', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'pyproject.toml');
      await writeFile(
        path,
        '[project]\nname = "demo"\ndependencies = ["foreign>=1", "owned==1"]\n',
      );
      await editTomlTable(path, {
        table: 'tool.opm',
        entries: [{ key: 'managed', value: 'true' }],
      });
      await editTomlArray(path, {
        table: 'project',
        key: 'dependencies',
        items: ['owned==2'],
        owns: (item) => item.startsWith('owned'),
      });
      const text = await readFile(path, 'utf8');
      expect(text).toContain('foreign>=1');
      expect(text).toContain('owned==2');
      expect(text).not.toContain('owned==1');
      expect(text).toContain('[tool.opm]');
    });
  });

  it('collects executable metadata and removes trees idempotently', async () => {
    await withTemp(async (dir) => {
      const nested = join(dir, 'tree', 'bin');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(nested, { recursive: true });
      const file = join(nested, 'tool');
      await writeFile(file, 'tool');
      await chmod(file, 0o755);
      expect(await collectFiles(join(dir, 'tree'), 'package')).toMatchObject([
        { path: 'package/bin/tool', executable: true },
      ]);
      await symlink(file, join(dir, 'tree', 'linked'));
      await expect(collectFiles(join(dir, 'tree'))).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      await removeTree(join(dir, 'tree'));
      await removeTree(join(dir, 'tree'));
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('archives', () => {
  it('is deterministic — the same input gives the same bytes', async () => {
    const { packTarGzip, packZip } = await import('./archive.js');
    const entries = [
      { path: 'b.txt', contents: new TextEncoder().encode('b') },
      { path: 'a.txt', contents: new TextEncoder().encode('a') },
    ];
    // Reversed input order too: archive order must not depend on the caller.
    expect(packTarGzip(entries)).toEqual(packTarGzip([...entries].reverse()));
    expect(packZip(entries)).toEqual(packZip([...entries].reverse()));
    for (const path of ['../escape', '/absolute', 'file:stream', 'a\\b']) {
      expect(() => packZip([{ path, contents: new Uint8Array() }])).toThrow(
        /Unsafe/u,
      );
    }
    for (const path of [
      '__proto__',
      'nested/__proto__/file',
      'constructor/file',
      'prototype/file',
    ]) {
      expect(() => packZip([{ path, contents: new Uint8Array(1) }])).toThrow(
        /Unsafe/u,
      );
    }
    expect(() => packTarGzip([...entries, entries[0]!])).toThrow(/duplicate/u);
  });
});
