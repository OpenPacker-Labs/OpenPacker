import { describe, expect, it } from 'vitest';
import { MemberOutput, memberLabel } from '../src/commands/run-output.js';

/** Every write, in order, with the stream it went to. */
function recorder() {
  const writes: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => (writes.push(`out|${s}`), true) },
      stderr: { write: (s: string) => (writes.push(`err|${s}`), true) },
    },
    writes,
  };
}

describe('MemberOutput, grouped', () => {
  it('holds a member back until it ends and then writes it as one block', () => {
    const { io, writes } = recorder();
    const a = new MemberOutput(io, '@s/a', 'group');
    const b = new MemberOutput(io, '@s/b', 'group');
    const sa = a.step('build');
    const sb = b.step('build');
    sa.stdout.write('one\n');
    sb.stdout.write('uno\n');
    sa.stderr.write('warn\n');
    sb.stdout.write('dos\n');
    expect(writes).toEqual([]);
    b.finish();
    a.finish();
    expect(writes).toEqual([
      'out|@s/b build: uno\n',
      'out|@s/b build: dos\n',
      'out|@s/a build: one\n',
      'err|@s/a build: warn\n',
    ]);
  });

  it('prefixes each step of a member with that step, hooks included', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'pkg', 'group');
    m.step('prebuild').stdout.write('p\n');
    m.step('build').stdout.write('b\n');
    m.step('postbuild').stdout.write('q\n');
    m.finish();
    expect(writes).toEqual([
      'out|pkg prebuild: p\n',
      'out|pkg build: b\n',
      'out|pkg postbuild: q\n',
    ]);
  });

  it('joins a line split across chunks and ends an unfinished last line', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'pkg', 'group');
    const s = m.step('t');
    s.stdout.write('hel');
    s.stdout.write('lo\nwor');
    s.stdout.write('ld');
    m.finish();
    expect(writes).toEqual(['out|pkg t: hello\n', 'out|pkg t: world\n']);
  });

  it('keeps blank lines and carriage returns inside a line', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'pkg', 'group');
    m.step('t').stdout.write('a\n\nb\r\n');
    m.finish();
    expect(writes).toEqual([
      'out|pkg t: a\n',
      'out|pkg t: \n',
      'out|pkg t: b\r\n',
    ]);
  });

  it('writes nothing for a member that printed nothing', () => {
    const { io, writes } = recorder();
    new MemberOutput(io, 'pkg', 'group').finish();
    expect(writes).toEqual([]);
  });

  it('streams what is past its limit, after the block it held', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'p', 'group', 40);
    const s = m.step('t');
    s.stdout.write('aaaaaaaaaa\n');
    s.stdout.write('bbbbbbbbbb\n');
    expect(writes).toEqual([]);
    s.stdout.write('cccccccccc\n');
    expect(writes).toEqual([
      'out|p t: aaaaaaaaaa\n',
      'out|p t: bbbbbbbbbb\n',
      'out|p t: cccccccccc\n',
    ]);
    s.stdout.write('dd\n');
    expect(writes.at(-1)).toBe('out|p t: dd\n');
  });
});

describe('MemberOutput, streaming', () => {
  it('writes each line as soon as it is complete', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'pkg', 'stream');
    const s = m.step('dev');
    s.stdout.write('ready');
    expect(writes).toEqual([]);
    s.stdout.write('\nnext\n');
    expect(writes).toEqual(['out|pkg dev: ready\n', 'out|pkg dev: next\n']);
    s.stderr.write('oops');
    m.finish();
    expect(writes.at(-1)).toBe('err|pkg dev: oops\n');
  });
});

describe('memberLabel', () => {
  it('is the name, else the directory, else a dot for the root', () => {
    expect(memberLabel({ name: '@s/a', dir: 'packages/a' })).toBe('@s/a');
    expect(memberLabel({ name: undefined, dir: 'packages/a' })).toBe(
      'packages/a',
    );
    expect(memberLabel({ name: undefined, dir: '' })).toBe('.');
  });
});
