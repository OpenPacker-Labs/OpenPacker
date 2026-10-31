import { describe, expect, it } from 'vitest';
import { MemberOutput, memberLabel } from '../src/commands/run-output.js';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

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

/** The documented bound on a line held back while it has no newline (ADR 0053 section 9). */
const LINE_BOUND = 64 * 1024;

/** The text of a write without its `<label> <step>: ` prefix and newline. */
function payload(write: string, prefix: string): string {
  const text = write.slice(write.indexOf('|') + 1);
  expect(text.startsWith(prefix), 'prefix').toBe(true);
  expect(text.endsWith('\n'), 'newline').toBe(true);
  return text.slice(prefix.length, -1);
}

describe('MemberOutput, a line with no newline', () => {
  it('is written out in pieces once it passes the bound, so streaming never holds it whole', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'p', 'stream');
    const s = m.step('t');
    const chunk = 'x'.repeat(16 * 1024);
    let pushed = 0;
    let written = 0;
    for (let i = 0; i < 256; i += 1) {
      s.stdout.write(chunk);
      pushed += chunk.length;
      written = writes.reduce((n, w) => n + payload(w, 'p t: ').length, 0);
      expect(
        pushed - written,
        `held after ${pushed} bytes`,
      ).toBeLessThanOrEqual(LINE_BOUND);
    }
    m.finish();
    const pieces = writes.map((w) => payload(w, 'p t: '));
    expect(pieces.join('')).toBe(chunk.repeat(256));
    for (const piece of pieces)
      expect(piece.length).toBeLessThanOrEqual(LINE_BOUND);
  });

  it('is bounded when grouped as well: the group limit plus one line, not the whole line', () => {
    const { io, writes } = recorder();
    const limit = 1024 * 1024;
    const m = new MemberOutput(io, 'p', 'group', limit);
    const s = m.step('t');
    const chunk = 'y'.repeat(32 * 1024);
    let pushed = 0;
    for (let i = 0; i < 256; i += 1) {
      s.stderr.write(chunk);
      pushed += chunk.length;
      const written = writes.reduce(
        (n, w) => n + payload(w, 'p t: ').length,
        0,
      );
      // What is held back is the block (up to the limit, prefixes counted) and one line.
      expect(
        pushed - written,
        `held after ${pushed} bytes`,
      ).toBeLessThanOrEqual(limit + LINE_BOUND);
    }
    m.finish();
    expect(writes.map((w) => payload(w, 'p t: ')).join('')).toBe(
      chunk.repeat(256),
    );
  });

  it('keeps the bytes of a long line in order, and a short line after it is a line of its own', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'p', 'stream');
    const s = m.step('t');
    const long = 'abcdefghij'.repeat(15_000);
    s.stdout.write(long.slice(0, 70_000));
    s.stdout.write(`${long.slice(70_000)}\nshort\n`);
    m.finish();
    const pieces = writes.map((w) => payload(w, 'p t: '));
    expect(pieces.at(-1)).toBe('short');
    expect(pieces.slice(0, -1).join('')).toBe(long);
    expect(pieces.length).toBe(1 + Math.ceil(long.length / LINE_BOUND));
  });

  it('cuts every line of one large chunk, and leaves a line of exactly the bound whole', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'p', 'stream');
    const s = m.step('t');
    const exact = 'e'.repeat(LINE_BOUND);
    s.stdout.write(`${'a'.repeat(100_000)}\n${'b'.repeat(100_000)}\n${exact}`);
    s.stdout.write('\n');
    m.finish();
    const pieces = writes.map((w) => payload(w, 'p t: '));
    for (const piece of pieces)
      expect(piece.length).toBeLessThanOrEqual(LINE_BOUND);
    expect(pieces.slice(0, 2).join('')).toBe(
      'a'.repeat(100_000).slice(0, 2 * LINE_BOUND),
    );
    expect(pieces.at(-1)).toBe(exact);
    expect(pieces).not.toContain('');
  });

  it('never cuts between the two halves of a character outside the BMP', () => {
    const { io, writes } = recorder();
    const m = new MemberOutput(io, 'p', 'stream');
    const s = m.step('t');
    const text = `a${'\u{1F600}'.repeat(60_000)}`;
    s.stdout.write(text);
    m.finish();
    const pieces = writes.map((w) => payload(w, 'p t: '));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces)
      expect(/\p{Surrogate}/u.test(piece)).toBe(false);
    expect(pieces.join('')).toBe(text);
  });

  it('takes a hundred megabytes of one line in well under the time a quadratic buffer needs', () => {
    const { io } = recorder();
    const m = new MemberOutput(io, 'p', 'stream');
    const s = m.step('t');
    const chunk = 'z'.repeat(64 * 1024);
    const before = cpuMs();
    for (let i = 0; i < 1600; i += 1) s.stdout.write(chunk);
    m.finish();
    // 100 MiB of it. The buffer this replaced re-joined and re-split the whole
    // held line on every chunk and needed minutes.
    expect(cpuMs() - before).toBeLessThan(20_000);
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
