/**
 * Type confusion for a document's reader: every field of a document replaced,
 * one at a time and then in seeded combinations, by a value of another JSON
 * type. A reader that dereferences a field it did not check meets `null`, a
 * number, an array or an object where it expected text, and throws a bare
 * `TypeError`, which `opm` writes as `opm: internal error: ...`.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** What replaces a field: one of each type a reader might not expect. */
export const CONFUSIONS: readonly Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  9007199254740991,
  '',
  'x',
  [],
  ['x'],
  [1],
  [null],
  [[]],
  {},
  { a: 1 },
  { a: {} },
];

export type Path = readonly (string | number)[];

export function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every path from the root, parents before children. */
export function pathsOf(value: Json, prefix: Path = []): Path[] {
  const own: Path[] = prefix.length === 0 ? [] : [prefix];
  if (Array.isArray(value))
    return [
      ...own,
      ...value.flatMap((item, index) => pathsOf(item, [...prefix, index])),
    ];
  if (isObject(value))
    return [
      ...own,
      ...Object.entries(value).flatMap(([key, item]) =>
        pathsOf(item, [...prefix, key]),
      ),
    ];
  return own;
}

function clone(value: Json): Json {
  return JSON.parse(JSON.stringify(value));
}

/** A copy of `root` with the value at `path` replaced, or removed when `replacement` is undefined. */
export function replaced(
  root: Json,
  path: Path,
  replacement: Json | undefined,
): Json {
  const copy = clone(root);
  let at: Json = copy;
  for (const step of path.slice(0, -1)) {
    if (Array.isArray(at) && typeof step === 'number') at = at[step]!;
    else if (isObject(at) && typeof step === 'string') at = at[step]!;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(at) && typeof last === 'number') {
    if (replacement === undefined) at.splice(last, 1);
    else at[last] = replacement;
  } else if (isObject(at) && typeof last === 'string') {
    if (replacement === undefined) delete at[last];
    else at[last] = replacement;
  }
  return copy;
}

/** A small seeded generator (xorshift), so that a failure can be replayed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

export function describePath(path: Path): string {
  return path.map(String).join('.');
}
