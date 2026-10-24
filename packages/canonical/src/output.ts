import { plainText } from './echo.js';

/**
 * The writers of the command lines.
 *
 * What a command writes to a terminal is made fit for one in a single place per
 * stream, so that a value a registry, a lock or a cloned repository chose cannot
 * retitle the window, move the cursor or hide text. The three streams a command
 * writes are three writers, and a repository test (`untrusted-url-sites`'s
 * neighbour, `stdout-writers.test.ts` in `apps/opm`) fails on any other
 * reference to either stream in the command lines' sources:
 *
 * - `report` for an error, to standard error: the prefix is the command's, the
 *   message is made plain and keeps its line feeds;
 * - `out` for text, `outJson` for a JSON document, to standard output;
 * - `outRaw` for what a child process wrote itself (a script, a tool, a host
 *   installer), which is passed through as it wrote it and named by the test.
 *
 * None of them can tell an entry the command wrote from a line a value added, so
 * a value is made one line where it is quoted (`plainLine`, `safeEcho`).
 */

/**
 * What an error's `message` may be when the error came from a library: its type
 * says a string, and a foreign value need not keep to that.
 */
export type MessageLike = string | number | boolean | bigint | null | undefined;

/** Where text is written: the part of a stream the writers use. */
export interface TextSink {
  write(chunk: string): boolean;
}

/** What `out`, `outJson` and `outRaw` write to. */
export interface Output {
  readonly stdout: TextSink;
}

/**
 * `prefix` and `message` as the lines of an error report, ending in a newline.
 * The prefix is ours; the message is made plain and keeps its line breaks. A
 * message that is not a string is written as `String` writes it.
 */
export function report(prefix: string, message: MessageLike): string {
  return `${prefix}${plainText(String(message))}\n`;
}

/**
 * Text for a terminal: escape sequences and control, format and bidirectional
 * characters removed, a carriage return a line feed, and the line feeds and
 * tabs a command writes itself (a listing is columns separated by a tab) kept.
 * Text with nothing to remove comes back as it is.
 */
export function plainOutput(text: string): string {
  return text.split('\t').map(plainText).join('\t');
}

/**
 * What a terminal acts on inside a JSON string, as code point ranges: the C1
 * controls, the soft hyphen, the zero-width and bidirectional characters, the
 * line and paragraph separators and the byte-order mark. Written as numbers so
 * that no line of this file holds a separator or an override.
 */
const ESCAPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x80, 0x9f],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const ESCAPED = new RegExp(
  `[${ESCAPED_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);

/**
 * A JSON document for a terminal. The characters a terminal acts on (C1
 * controls, soft hyphen, zero-width and bidirectional characters, the line and
 * paragraph separators, the byte-order mark) can only stand inside a string of a
 * JSON text, and are written as escapes there: the text parses to the same
 * document, and shows none of them. JSON itself escapes the rest of the C0
 * controls.
 */
export function jsonOutput(text: string): string {
  return text.replace(
    ESCAPED,
    (character) =>
      `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

/** Text to standard output, made plain. The text carries its own line feeds. */
export function out(io: Output, text: string): void {
  io.stdout.write(plainOutput(text));
}

/** A JSON document to standard output, made fit for a terminal, and a line feed. */
export function outJson(io: Output, document: string): void {
  io.stdout.write(`${jsonOutput(document)}\n`);
}

/**
 * What a child process wrote to its own standard output, passed through as it
 * wrote it: a script's output is the script's, and a tool's the tool's.
 */
export function outRaw(io: Output, chunk: string): void {
  io.stdout.write(chunk);
}
