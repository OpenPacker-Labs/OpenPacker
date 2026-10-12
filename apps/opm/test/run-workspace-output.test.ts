import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  go,
  makeWorkspace,
  started,
  steps,
  trace,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

/**
 * Two members that hand files back and forth, so their lines come in the order
 * a1 b1 a2 b2 whatever the machine is doing.
 */
async function talkers() {
  return await makeWorkspace({
    'packages/a': {
      name: '@s/a',
      scripts: {
        talk: steps(
          'say:a1',
          'touch:f0',
          'wait:f1',
          'sleep:80',
          'say:a2',
          'touch:f2',
        ),
      },
    },
    'packages/b': {
      name: '@s/b',
      scripts: {
        talk: steps(
          'wait:f0',
          'sleep:80',
          'say:b1',
          'touch:f1',
          'wait:f2',
          'sleep:80',
          'say:b2',
        ),
      },
    },
  });
}

posix('what a member prints', () => {
  it('prefixes every line with the member and the script, stdout and stderr alike', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: '@s/a',
        scripts: { talk: 'echo out; echo err >&2' },
      },
      'packages/b': { name: '@s/b', scripts: { talk: 'echo other' } },
    });
    const ran = await go(
      'run',
      ['talk', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out.split('\n').filter(Boolean).sort()).toEqual([
      '@s/a talk: out',
      '@s/b talk: other',
    ]);
    expect(ran.err).toBe('@s/a talk: err\n');
  });

  it('prefixes the hooks with their own names', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          prebuild: 'echo pre',
          build: 'echo main',
          postbuild: 'echo post',
        },
      },
      'packages/b': { name: 'b', scripts: { build: 'echo b' } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.out.split('\n').filter((l) => l.startsWith('a '))).toEqual([
      'a prebuild: pre',
      'a build: main',
      'a postbuild: post',
    ]);
  });

  it('shows a member without a name by its directory', async () => {
    const ws = await makeWorkspace({
      'packages/plain': { scripts: { talk: 'echo hi' } },
      'packages/other': { name: 'other', scripts: { talk: 'echo yo' } },
    });
    const ran = await go(
      'run',
      ['talk', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.out).toContain('packages/plain talk: hi\n');
  });

  it('holds each member back and writes it as one block when run at once', async () => {
    const ws = await talkers();
    const ran = await go(
      'run',
      ['talk', '-r', '--workspace-concurrency=2'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    const lines = ran.out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    // Whichever member ends first is written first; neither is cut by the other.
    const a = lines.filter((l) => l.startsWith('@s/a '));
    const b = lines.filter((l) => l.startsWith('@s/b '));
    expect(a).toEqual(['@s/a talk: a1', '@s/a talk: a2']);
    expect(b).toEqual(['@s/b talk: b1', '@s/b talk: b2']);
    const first = lines[0]!.startsWith('@s/a ') ? a : b;
    expect(lines.slice(0, 2)).toEqual(first);
  });

  it('interleaves the lines as they arrive with --stream', async () => {
    const ws = await talkers();
    const ran = await go(
      'run',
      ['talk', '-r', '--workspace-concurrency=2', '--stream'],
      ws.root,
    );
    expect(ran.out.split('\n').filter(Boolean)).toEqual([
      '@s/a talk: a1',
      '@s/b talk: b1',
      '@s/a talk: a2',
      '@s/b talk: b2',
    ]);
  });

  it('streams with --parallel, which has no use for a block', async () => {
    const ws = await talkers();
    const ran = await go('run', ['talk', '-r', '--parallel'], ws.root);
    expect(ran.out.split('\n').filter(Boolean)).toEqual([
      '@s/a talk: a1',
      '@s/b talk: b1',
      '@s/a talk: a2',
      '@s/b talk: b2',
    ]);
  });

  it('runs a lone member as opm run would: no prefix, its own stdin', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: '@s/a', scripts: { talk: 'echo plain' } },
      'packages/b': { name: '@s/b', scripts: { other: 'true' } },
    });
    const ran = await go('run', ['talk', '-r'], ws.root);
    expect(ran.out).toBe('plain\n');
  });

  it('gives several members no stdin at all', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { rd: 'cat; echo done' } },
      'packages/b': { name: 'b', scripts: { rd: 'cat; echo done' } },
    });
    const ran = await go('run', ['rd', '-r'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out.split('\n').filter(Boolean).sort()).toEqual([
      'a rd: done',
      'b rd: done',
    ]);
  });

  it('writes a line with no newline in prefixed pieces, grouped and streamed alike', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          wide: `node -e "process.stdout.write('x'.repeat(300000)); process.stdout.write('\\nend\\n')"`,
        },
      },
      'packages/b': { name: 'b', scripts: { wide: 'echo b' } },
    });
    for (const flag of [[], ['--stream']]) {
      const ran = await go('run', ['wide', '-r', ...flag], ws.root);
      expect(ran.status, ran.err).toBe(0);
      const lines = ran.out.split('\n').filter((l) => l.startsWith('a wide: '));
      const pieces = lines.map((l) => l.slice('a wide: '.length));
      expect(pieces.at(-1), flag.join()).toBe('end');
      for (const piece of pieces)
        expect(piece.length).toBeLessThanOrEqual(64 * 1024);
      expect(pieces.slice(0, -1).join('')).toBe('x'.repeat(300_000));
      expect(ran.out).toContain('b wide: b\n');
    }
  });

  it('passes arguments after -- to the script of every member and to no hook', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: { prex: 'echo hook', x: 'echo main' },
      },
      'packages/b': { name: 'b', scripts: { x: 'echo main' } },
    });
    const ran = await go(
      'run',
      ['x', '-r', '--workspace-concurrency=1', '--', 'ARG', 'two words'],
      ws.root,
    );
    expect(ran.out).toContain('a x: main ARG two words\n');
    expect(ran.out).toContain('b x: main ARG two words\n');
    expect(ran.out).toContain('a prex: hook\n');
  });
});

posix('what a member sees', () => {
  it('has its own directory, name, version, step and the directory opm started in', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: '@s/a',
        version: '1.2.3',
        scripts: {
          prewho: 'node "$INIT_CWD/whoami.cjs"',
          who: 'node "$INIT_CWD/whoami.cjs"',
        },
      },
      'packages/b': {
        name: 'b',
        version: '0.0.1',
        scripts: { who: 'node "$INIT_CWD/whoami.cjs"' },
      },
    });
    const ran = await go(
      'run',
      ['who', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    const seen = ran.out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        label: line.slice(0, line.indexOf(': ')),
        info: JSON.parse(line.slice(line.indexOf(': ') + 2)) as Record<
          string,
          unknown
        >,
      }));
    expect(seen.map((s) => s.label)).toEqual([
      '@s/a prewho',
      '@s/a who',
      'b who',
    ]);
    const [pre, main, other] = seen.map((s) => s.info);
    expect(pre).toMatchObject({
      event: 'prewho',
      name: '@s/a',
      version: '1.2.3',
    });
    expect(main).toMatchObject({
      cwd: join(ws.root, 'packages', 'a'),
      event: 'who',
      name: '@s/a',
      version: '1.2.3',
      initCwd: ws.root,
    });
    expect(other).toMatchObject({
      cwd: join(ws.root, 'packages', 'b'),
      name: 'b',
      version: '0.0.1',
    });
    // The member's .bin first, then each parent's up to the root's.
    expect(main?.path).toEqual([
      join(ws.root, 'packages', 'a', 'node_modules', '.bin'),
      join(ws.root, 'packages', 'node_modules', '.bin'),
      join(ws.root, 'node_modules', '.bin'),
    ]);
  });

  it('finds an executable in the workspace root .bin from a member', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { t: 'fake-tool one' } },
      'packages/b': { name: 'b', scripts: { t: 'fake-tool two' } },
    });
    const ran = await go(
      'run',
      ['t', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out).toContain('"argv":["one"]');
    expect(ran.out).toContain('"argv":["two"]');
  });

  it('runs a member started in a subdirectory with INIT_CWD kept as that directory', async () => {
    const ws = await makeWorkspace(
      {
        'packages/a': {
          name: 'a',
          scripts: { who: 'node "$INIT_CWD/../whoami.cjs"' },
        },
      },
      { opm: true },
    );
    const here = join(ws.root, 'packages');
    const ran = await go('run', ['who', '--filter', 'a'], here);
    expect(ran.status, ran.err).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ initCwd: here, name: 'a' });
  });

  it('resolves ./dir filters from the directory opm was started in', async () => {
    const ws = await makeWorkspace(
      {
        'packages/a': { name: 'a', scripts: { t: trace('a') } },
        'packages/b': { name: 'b', scripts: { t: trace('b') } },
      },
      { opm: true },
    );
    const ran = await go(
      'run',
      ['t', '--filter', './b'],
      join(ws.root, 'packages'),
      (await import('./workspace-fixture.js')).contextWith({
        INIT_CWD: ws.root,
      }),
    );
    expect(ran.status, ran.err).toBe(0);
    expect(started(await ws.log())).toEqual(['b']);
  });
});
