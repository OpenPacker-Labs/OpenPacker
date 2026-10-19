/**
 * The output of a run over several members (ADR 0053): every line carries the
 * member and the script it came from, so a failing line in a long run says
 * where it belongs.
 *
 * Two shapes. Grouped (the default) holds a member's lines until the member
 * ends and then writes them as one block, so blocks never interleave and a
 * log reads member by member. Streaming (`--stream`, and `--parallel`) writes
 * each line as it arrives. A member whose held output passes
 * {@link GROUP_LIMIT} bytes is written out and streams from then on: memory
 * is bounded, and the ordering promise is given up only for output nobody
 * would read as a block.
 *
 * A line with no newline is bounded too. Minified JSON, base64 and a progress
 * bar that only returns the carriage are one line however long they run, so a
 * line that passes {@link LINE_LIMIT} is written as several, each with the
 * prefix. What a member holds back is then its block (up to the group limit)
 * and at most one unfinished line per stream.
 */
import { outRaw, plainLine } from '@openpacker/canonical';
import type { ChildIo } from './run-child.js';

export const GROUP_LIMIT = 8 * 1024 * 1024;

/** The longest piece of a line held back or written as one prefixed line, in UTF-16 units. */
export const LINE_LIMIT = 64 * 1024;

export type OutputMode = 'group' | 'stream';

type Stream = 'stdout' | 'stderr';

/** Where to cut `text` at `limit`: never between the two halves of a surrogate pair. */
function cutAt(text: string, limit: number): number {
  const before = text.charCodeAt(limit - 1);
  return before >= 0xd800 && before <= 0xdbff ? limit - 1 : limit;
}

/**
 * Cuts a stream of chunks into lines; the last, unfinished line waits for
 * `end`. A line is looked for in the new chunk only, and what waits never
 * passes {@link LINE_LIMIT}, so the work for n bytes is n, not n squared.
 */
class Lines {
  private pending = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    let from = 0;
    for (
      let at = chunk.indexOf('\n');
      at !== -1;
      at = chunk.indexOf('\n', from)
    ) {
      this.emitLine(this.pending + chunk.slice(from, at));
      this.pending = '';
      from = at + 1;
    }
    this.pending += chunk.slice(from);
    while (this.pending.length > LINE_LIMIT) {
      const cut = cutAt(this.pending, LINE_LIMIT);
      this.emit(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
  }

  end(): void {
    if (this.pending === '') return;
    const last = this.pending;
    this.pending = '';
    this.emit(last);
  }

  /** A finished line, written as pieces when it is longer than the limit. */
  private emitLine(line: string): void {
    let rest = line;
    while (rest.length > LINE_LIMIT) {
      const cut = cutAt(rest, LINE_LIMIT);
      this.emit(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    this.emit(rest);
  }
}

/** Writes lines of one member, grouped or streamed, to the real output. */
export class MemberOutput {
  private readonly held: { stream: Stream; text: string }[] = [];
  private heldBytes = 0;
  private streaming: boolean;
  private readonly lines: { stdout: Lines; stderr: Lines };
  private prefix = '';

  constructor(
    private readonly out: ChildIo,
    private readonly label: string,
    mode: OutputMode,
    private readonly limit: number = GROUP_LIMIT,
  ) {
    this.streaming = mode === 'stream';
    this.lines = {
      stdout: new Lines((line) => {
        this.write('stdout', line);
      }),
      stderr: new Lines((line) => {
        this.write('stderr', line);
      }),
    };
  }

  /** The streams for one step of the member (`build`, `prebuild`, `tsc`). */
  step(name: string): ChildIo {
    this.endLines();
    this.prefix = `${this.label} ${plainLine(name)}: `;
    return {
      stdout: { write: (chunk) => this.take('stdout', String(chunk)) },
      stderr: { write: (chunk) => this.take('stderr', String(chunk)) },
    };
  }

  private take(stream: Stream, chunk: string): boolean {
    this.lines[stream].push(chunk);
    return true;
  }

  private endLines(): void {
    this.lines.stdout.end();
    this.lines.stderr.end();
  }

  private write(stream: Stream, line: string): void {
    const text = `${this.prefix}${line}\n`;
    if (this.streaming) {
      this.emit(stream, text);
      return;
    }
    this.held.push({ stream, text });
    this.heldBytes += text.length;
    if (this.heldBytes > this.limit) {
      this.streaming = true;
      this.flush();
    }
  }

  private flush(): void {
    for (const { stream, text } of this.held.splice(0)) this.emit(stream, text);
    this.heldBytes = 0;
  }

  /**
   * A line of the member's own output after its prefix: the prefix is opm's and
   * one plain line (`memberLabel`, `step`), the rest is what the child wrote, as
   * a single run passes it through (`run-child.ts`).
   */
  private emit(stream: Stream, text: string): void {
    if (stream === 'stdout') outRaw(this.out, text);
    else this.out.stderr.write(text);
  }

  /** The member has ended: finish the last lines and write what is held. */
  finish(): void {
    this.endLines();
    this.flush();
  }
}

/**
 * The label a member is shown by: its name, else its directory (`.` for the
 * root). A directory is named by whoever made the repository, and the label
 * starts every line of the member's output and names it in every message, so it
 * is one plain line.
 */
export function memberLabel(member: {
  name: string | undefined;
  dir: string;
}): string {
  return plainLine(member.name ?? (member.dir === '' ? '.' : member.dir));
}
