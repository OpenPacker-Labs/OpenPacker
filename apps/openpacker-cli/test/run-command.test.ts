import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { capture, makeDirectory, makeProject, report } from './run-fixture.js';

async function log(root: string): Promise<string[]> {
  try {
    return (await readFile(join(root, 'log.txt'), 'utf8'))
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe('opm run: listing', () => {
  it('lists the scripts, name and command, in file order', async () => {
    const root = await makeProject({
      scripts: { ver: 'vitest --version', test: 'vitest run' },
    });
    const cap = capture();
    expect(await runOpm(['run'], cap.io, root)).toBe(0);
    expect(cap.out).toBe('ver\tvitest --version\ntest\tvitest run\n');
  });

  it('says so when there are none', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(await runOpm(['run'], cap.io, root)).toBe(0);
    expect(cap.out).toBe('(no scripts)\n');
  });
});

describe('opm run: hooks and exit codes', () => {
  it('runs pre<name>, <name>, post<name> in that order', async () => {
    const root = await makeProject({
      scripts: {
        pretest: 'node mark.cjs pre',
        test: 'node mark.cjs main',
        posttest: 'node mark.cjs post',
        other: 'node mark.cjs other',
      },
    });
    const cap = capture();
    expect(await runOpm(['run', 'test'], cap.io, root), cap.err).toBe(0);
    expect(await log(root)).toEqual(['pre', 'main', 'post']);
  });

  it('runs only the hooks that exist', async () => {
    const root = await makeProject({
      scripts: { test: 'node mark.cjs main', posttest: 'node mark.cjs post' },
    });
    await runOpm(['run', 'test'], capture().io, root);
    expect(await log(root)).toEqual(['main', 'post']);
  });

  it('propagates the exit code exactly and names the script that failed', async () => {
    const root = await makeProject({ scripts: { fail: 'node fail.cjs 7' } });
    const cap = capture();
    expect(await runOpm(['run', 'fail'], cap.io, root)).toBe(7);
    expect(cap.err).toBe('opm: script "fail" exited with code 7\n');
  });

  it.each([1, 2, 3, 4, 9, 42, 255])(
    'exits %i when the script does',
    async (code) => {
      const root = await makeProject({
        scripts: { x: `node fail.cjs ${code}` },
      });
      expect(await runOpm(['run', 'x'], capture().io, root)).toBe(code);
    },
  );

  it('stops at a failing hook: the script and later hooks do not run', async () => {
    const root = await makeProject({
      scripts: {
        pretest: 'node mark.cjs pre && node fail.cjs 3',
        test: 'node mark.cjs main',
        posttest: 'node mark.cjs post',
      },
    });
    const cap = capture();
    expect(await runOpm(['run', 'test'], cap.io, root)).toBe(3);
    expect(await log(root)).toEqual(['pre']);
    expect(cap.err).toContain('script "pretest" exited with code 3');
  });

  it('does not run post<name> when the script fails', async () => {
    const root = await makeProject({
      scripts: { test: 'node fail.cjs 5', posttest: 'node mark.cjs post' },
    });
    expect(await runOpm(['run', 'test'], capture().io, root)).toBe(5);
    expect(await log(root)).toEqual([]);
  });

  it('exits with the status of a failing post hook', async () => {
    const root = await makeProject({
      scripts: { test: 'node mark.cjs main', posttest: 'node fail.cjs 6' },
    });
    expect(await runOpm(['run', 'test'], capture().io, root)).toBe(6);
    expect(await log(root)).toEqual(['main']);
  });

  it('runs a command chain the way a shell does', async () => {
    const root = await makeProject({
      scripts: { chain: 'node mark.cjs a && node mark.cjs b' },
    });
    expect(await runOpm(['run', 'chain'], capture().io, root)).toBe(0);
    expect(await log(root)).toEqual(['a', 'b']);
  });

  it.skipIf(process.platform === 'win32')(
    'exits 128 plus the signal number when a signal ends the script',
    async () => {
      // The shell that runs the script reports its child's death as 143, so
      // opm sees an ordinary exit with that code, as npm does.
      const root = await makeProject({
        scripts: { die: 'node kill-self.cjs' },
      });
      const cap = capture();
      expect(await runOpm(['run', 'die'], cap.io, root)).toBe(143);
      expect(cap.err).toContain('opm: script "die" exited with code 143\n');
    },
  );
});

describe('opm run: arguments', () => {
  it('appends the arguments after -- to the script, to it and not to its hooks', async () => {
    const root = await makeProject({
      scripts: {
        prego: 'node mark.cjs pre',
        go: 'node node_modules/fake-tool/cli.js',
      },
    });
    const cap = capture();
    expect(
      await runOpm(
        ['run', 'go', '--', '--watch', 'a b', '$(id)', '"q"'],
        cap.io,
        root,
      ),
    ).toBe(0);
    expect(report(cap.out).argv).toEqual(['--watch', 'a b', '$(id)', '"q"']);
    expect(await log(root)).toEqual(['pre']);
  });

  it('refuses a flag of its own it does not know', async () => {
    const root = await makeProject({ scripts: { go: 'node mark.cjs go' } });
    const cap = capture();
    expect(await runOpm(['run', 'go', '--watch'], cap.io, root)).toBe(2);
    expect(cap.err).toContain('Unknown option --watch for opm run');
    expect(await log(root)).toEqual([]);
  });
});

describe('opm run: a missing script', () => {
  it('is not found: exit 4, with the scripts that do exist', async () => {
    const root = await makeProject({
      scripts: { build: 'node mark.cjs b', test: 'node mark.cjs t' },
    });
    const cap = capture();
    expect(await runOpm(['run', 'nope'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('No script "nope"');
    expect(cap.err).toContain('it has: build, test');
    expect(cap.out).toBe('');
  });

  it('says a package with no scripts has none', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(await runOpm(['run', 'nope'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('it has no scripts');
  });

  it('exits 0 and runs nothing under --if-present, hooks included', async () => {
    const root = await makeProject({
      scripts: { prelint: 'node mark.cjs pre' },
    });
    const cap = capture();
    expect(await runOpm(['run', '--if-present', 'lint'], cap.io, root)).toBe(0);
    expect(cap.out + cap.err).toBe('');
    expect(await log(root)).toEqual([]);
  });

  it('still runs a script that is present under --if-present', async () => {
    const root = await makeProject({ scripts: { lint: 'node mark.cjs lint' } });
    expect(
      await runOpm(['run', 'lint', '--if-present'], capture().io, root),
    ).toBe(0);
    expect(await log(root)).toEqual(['lint']);
  });

  it('is not found when there is no package.json', async () => {
    const root = await makeProject({ noPackage: true });
    const cap = capture();
    expect(await runOpm(['run', 'x'], cap.io, root)).toBe(4);
    expect(cap.err).toContain('No package.json');
  });

  it('is invalid input when package.json does not parse', async () => {
    const root = await makeProject({});
    await writeFile(join(root, 'package.json'), '{ nope');
    const cap = capture();
    expect(await runOpm(['run', 'x'], cap.io, root)).toBe(3);
    expect(cap.err).toContain('is not valid JSON');
  });

  it('is invalid input when the named script is not a string', async () => {
    const root = await makeProject({});
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { x: 5 } }),
    );
    expect(await runOpm(['run', 'x'], capture().io, root)).toBe(3);
  });
});

describe('opm run: where it runs', () => {
  it('uses the opm project root from a subdirectory, and runs there', async () => {
    const root = await makeProject({
      opm: true,
      scripts: { where: 'node node_modules/fake-tool/cli.js' },
    });
    const sub = await makeDirectory(root, 'src/deep');
    const cap = capture();
    expect(await runOpm(['run', 'where'], cap.io, sub)).toBe(0);
    expect(report(cap.out).cwd).toBe(root);
  });

  it('takes --path as the project exactly, whatever opm project is above it', async () => {
    const root = await makeProject({
      opm: true,
      scripts: { who: 'node mark.cjs outer' },
    });
    const inner = await makeDirectory(root, 'inner');
    await writeFile(
      join(inner, 'package.json'),
      JSON.stringify({
        scripts: {
          who: "node -e \"require('fs').appendFileSync('inner.txt', 'x')\"",
        },
      }),
    );
    for (const given of ['inner', inner]) {
      const cap = capture();
      expect(
        await runOpm(['run', 'who', '--path', given], cap.io, root),
        cap.err,
      ).toBe(0);
    }
    expect(await readFile(join(inner, 'inner.txt'), 'utf8')).toBe('xx');
    expect(await log(root)).toEqual([]);
  });
});
