/**
 * Surgical edits to TOML project files.
 *
 * `smol-toml` parses TOML; it does not preserve comments or formatting when it
 * re-emits, and `Cargo.toml` and `pyproject.toml` are full of both. So the
 * parser is used to know what is there and to prove the result is still valid,
 * while the edit itself replaces individual lines.
 */

import { parse } from 'smol-toml';
import {
  ProjectIoError,
  matchFileStyle,
  readTextFile,
  writeFileAtomic,
} from './index.js';

export interface TomlTableEdit {
  /** Table header, e.g. `dependencies` or `project.optional-dependencies`. */
  table: string;
  /** Keys to set, in the order they should appear when newly inserted. */
  entries: readonly { key: string; value: string }[];
  /** Keys to delete if present. */
  retire?: readonly string[];
}

/**
 * Set `key = value` lines inside a `[table]`, creating the table if needed.
 *
 * `value` is written verbatim, so the caller controls whether it is a quoted
 * string or an inline table — those are different in every format that uses
 * this, and quoting for them here would be guessing.
 */
export async function editTomlTable(
  path: string,
  edit: TomlTableEdit,
): Promise<{ changed: boolean }> {
  const file = await readTextFile(path);
  const lines = file.text.split('\n');
  const section = findTable(lines, edit.table);
  const retire = new Set(edit.retire ?? []);

  let body: string[];
  if (!section) {
    if (edit.entries.length === 0) return { changed: false };
    // A table that does not exist has nothing to retire and everything to add.
    body = [
      ...lines,
      ...(lines.at(-1) === '' ? [] : ['']),
      `[${edit.table}]`,
      ...edit.entries.map((entry) => `${entry.key} = ${entry.value}`),
      '',
    ];
  } else {
    const inner = lines.slice(section.start + 1, section.end);
    const wanted = new Map(
      edit.entries.map((entry) => [entry.key, entry.value]),
    );
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const line of inner) {
      const key = keyOf(line);
      if (key === undefined) {
        kept.push(line);
        continue;
      }
      if (wanted.has(key)) {
        seen.add(key);
        kept.push(`${key} = ${wanted.get(key)!}`);
        continue;
      }
      if (retire.has(key)) continue;
      kept.push(line);
    }
    const additions = edit.entries
      .filter((entry) => !seen.has(entry.key))
      .map((entry) => `${entry.key} = ${entry.value}`);
    // New keys go after the last existing assignment, so trailing comments and
    // blank lines that separate this table from the next stay at the end.
    const lastAssignment = lastIndexWhere(
      kept,
      (line) => keyOf(line) !== undefined,
    );
    const at = lastAssignment === -1 ? kept.length : lastAssignment + 1;
    kept.splice(at, 0, ...additions);
    body = [
      ...lines.slice(0, section.start + 1),
      ...kept,
      ...lines.slice(section.end),
    ];
  }

  const next = matchFileStyle(file, body.join('\n'));
  if (next === file.text) return { changed: false };
  assertToml(path, next);
  await writeFileAtomic(path, next);
  return { changed: true };
}

export interface TomlArrayEdit {
  /** Table header the array lives in, e.g. `project`. */
  table: string;
  /** Array key, e.g. `dependencies`. */
  key: string;
  /** The complete set of items opm manages, already rendered as TOML strings. */
  items: readonly string[];
  /**
   * Predicate identifying an existing item as one opm manages. Items that do
   * not match are left where they are — they belong to whoever wrote them.
   */
  owns: (item: string) => boolean;
}

/**
 * Replace opm's items in an array-of-strings key, leaving the rest.
 *
 * PEP 621 puts dependencies in `project.dependencies` as PEP 508 strings, so
 * there are no per-key lines to edit — the array is rewritten as a whole, with
 * every item nobody claims carried across in its original order.
 */
export async function editTomlArray(
  path: string,
  edit: TomlArrayEdit,
): Promise<{ changed: boolean }> {
  const file = await readTextFile(path);
  const lines = file.text.split('\n');
  const section = findTable(lines, edit.table);
  const rendered = (items: readonly string[]) =>
    items.length === 0
      ? `${edit.key} = []`
      : `${edit.key} = [\n${items.map((item) => `  ${JSON.stringify(item)},`).join('\n')}\n]`;

  let body: string[];
  if (!section) {
    if (edit.items.length === 0) return { changed: false };
    body = [
      ...lines,
      ...(lines.at(-1) === '' ? [] : ['']),
      `[${edit.table}]`,
      rendered([...edit.items]),
      '',
    ];
  } else {
    const inner = lines.slice(section.start + 1, section.end);
    const span = findArraySpan(inner, edit.key);
    const existing =
      span === undefined
        ? []
        : parseArrayItems(inner.slice(span.start, span.end + 1).join('\n'));
    const foreign = existing.filter((item) => !edit.owns(item));
    const merged = [...foreign, ...edit.items];
    const replacement = rendered(merged).split('\n');
    const nextInner =
      span === undefined
        ? [...inner, ...replacement]
        : [
            ...inner.slice(0, span.start),
            ...replacement,
            ...inner.slice(span.end + 1),
          ];
    body = [
      ...lines.slice(0, section.start + 1),
      ...nextInner,
      ...lines.slice(section.end),
    ];
  }

  const next = matchFileStyle(file, body.join('\n'));
  if (next === file.text) return { changed: false };
  assertToml(path, next);
  await writeFileAtomic(path, next);
  return { changed: true };
}

/** Line range of a `[table]` header's body, exclusive of the next header. */
function findTable(
  lines: readonly string[],
  table: string,
): { start: number; end: number } | undefined {
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** The bare or quoted key a line assigns, if it assigns one. */
function keyOf(line: string): string | undefined {
  const match = /^\s*(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=/u.exec(line);
  if (!match) return undefined;
  return match[1] ?? match[2];
}

function lastIndexWhere(
  lines: readonly string[],
  predicate: (line: string) => boolean,
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1)
    if (predicate(lines[index]!)) return index;
  return -1;
}

/** Line range of an array assignment, spanning a multi-line array. */
function findArraySpan(
  lines: readonly string[],
  key: string,
): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => keyOf(line) === key);
  if (start === -1) return undefined;
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]!) {
      if (character === '[') depth += 1;
      else if (character === ']') depth -= 1;
    }
    if (depth <= 0) return { start, end: index };
  }
  return { start, end: lines.length - 1 };
}

/** The string items of an array assignment, via the real TOML parser. */
function parseArrayItems(assignment: string): string[] {
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = parse(assignment) as Record<string, unknown>;
    const value = Object.values(parsed)[0];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function assertToml(path: string, text: string): void {
  try {
    parse(text);
  } catch (error) {
    throw new ProjectIoError(
      'INVALID_TOML',
      path,
      `Editing ${path} produced TOML that does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
