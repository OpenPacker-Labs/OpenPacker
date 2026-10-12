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
 */
import type { ChildIo } from './run-child.js';

export const GROUP_LIMIT = 8 * 1024 * 1024;

export type OutputMode = 'group' | 'stream';

type Stream = 'stdout' | 'stderr';

/** Cuts a stream of chunks into lines; the last, unfinished line waits for `end`. */
class Lines {
  private pending = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    const text = this.pending + chunk;
    const parts = text.split('\n');
    this.pending = parts.pop() ?? '';
    for (const part of parts) this.emit(part);
  }

  end(): void {
    if (this.pending === '') return;
    const last = this.pending;
    this.pending = '';
    this.emit(last);
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
    this.prefix = `${this.label} ${name}: `;
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
      this.out[stream].write(text);
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
    for (const { stream, text } of this.held.splice(0))
      this.out[stream].write(text);
    this.heldBytes = 0;
  }

  /** The member has ended: finish the last lines and write what is held. */
  finish(): void {
    this.endLines();
    this.flush();
  }
}

/** The label a member is shown by: its name, else its directory (`.` for the root). */
export function memberLabel(member: {
  name: string | undefined;
  dir: string;
}): string {
  return member.name ?? (member.dir === '' ? '.' : member.dir);
}
