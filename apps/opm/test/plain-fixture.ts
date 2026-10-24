import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { runOpm, type RunOpmOptions } from '../src/opm.js';
import { capture } from './capture.js';
import type { Json, Ran } from './repo-fixture.js';

/** Characters by code point, so no source line holds a separator or an override. */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
/** A character class from inclusive ranges of code points. */
const classOf = (...ranges: [number, number][]): RegExp =>
  new RegExp(
    `[${ranges
      .map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`)
      .join('')}]`,
    'u',
  );

/**
 * Text that a cloned repository's file value must not turn into output. It
 * starts lines that look like opm's own after every kind of line break a
 * terminal or a reader may take (LF, CR, NEL, U+2028, U+2029), and carries what
 * a terminal acts on: a C1 control sequence, a bidirectional override, an escape
 * sequence, a bell, a delete, a byte-order mark and a zero-width space.
 */
export const HOSTILE = [
  '\nopm: ok installed 1 package@1\n  - pkg:npm/b@1: forged',
  chars(0x202e, 0x85),
  'ZZQ',
  chars(0x9b),
  '31m\rZZQ2',
  chars(0x2028),
  'ZZQ3',
  chars(0x2029, 0x07, 0x7f, 0xfeff, 0x200b, 0x1b),
  '[2K',
].join('');

const LINE_BREAKS = new RegExp(
  `\\r\\n|[\\n\\r${chars(0x85, 0x2028, 0x2029)}]`,
  'u',
);
const FORGED = /^(opm: ok installed 1 package|  - pkg:npm\/b@1: forged|ZZQ)/u;
/** Everything but LF and tab that a terminal or a reader treats as more than text. */
const NOT_TEXT = classOf(
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
);

/** What is wrong with what was written: a forged line, or a character that is not text. */
export function violations(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(LINE_BREAKS))
    if (FORGED.test(line)) found.push(`forged line: ${JSON.stringify(line)}`);
  const odd = NOT_TEXT.exec(text);
  if (odd !== null)
    found.push(
      `not text: U+${(odd[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
    );
  return found;
}

/** The number of lines in what was written, however they are broken. */
export function lines(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/u, '').split(LINE_BREAKS).length;
}

/**
 * A command run twice, with `x` and with hostile text in the value under test,
 * ends the same way, writes the same number of lines to each stream, and writes
 * no forged line and no character a terminal acts on to either.
 */
export async function expectPlain(
  go: (text: string) => Promise<Ran>,
  hostileText = HOSTILE,
): Promise<void> {
  const innocent = await go('x');
  const hostile = await go(hostileText);
  expect(hostile.code, hostile.err).toBe(innocent.code);
  for (const stream of ['out', 'err'] as const) {
    expect(violations(hostile[stream])).toEqual([]);
    expect(lines(hostile[stream])).toBe(lines(innocent[stream]));
  }
}

/** Writes `files` into a fresh directory and runs `opm <argv>` there. */
export async function runWith(
  files: Record<string, string>,
  argv: string[],
  options: RunOpmOptions = {},
): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-plain-'));
  const previous = process.env.OPM_STORE_HOME;
  process.env.OPM_STORE_HOME = join(dir, '.store');
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    const cap = capture();
    const code = await runOpm(argv, cap.io, dir, options);
    return { code, out: cap.out, err: cap.err };
  } finally {
    if (previous === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A project `opm ci` installs from, with a `fetch` that serves its archives. */
export function ciProject(edit: (builds: Json, text: string) => void) {
  const origin = 'https://registry.npmjs.org';
  return async (text: string, argv: string[]): Promise<Ran> => {
    const archives = new Map<string, Uint8Array>();
    const packages: Record<string, Json> = {};
    const add = (name: string, version: string, extra: Json = {}): Json => {
      const bytes = packTarGzip([
        {
          path: 'package/package.json',
          contents: new TextEncoder().encode(
            JSON.stringify({ name, version, bin: { [name]: 'cli.js' } }),
          ),
        },
        {
          path: 'package/cli.js',
          contents: new TextEncoder().encode(`console.log('${name}');\n`),
        },
      ]);
      const url = `${origin}/${name}/-/${name}-${version}.tgz`;
      archives.set(url, bytes);
      const entry: Json = {
        version,
        resolved: url,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        ...extra,
      };
      packages[`node_modules/${name}`] = entry;
      return entry;
    };
    add('runtime', '1.0.0');
    add('test-tool', '2.0.0', { dev: true });
    const builds = add('builds', '3.0.0', { hasInstallScript: true });
    edit(builds, text);
    const manifest = {
      name: 'app',
      version: '1.0.0',
      dependencies: { runtime: '1.0.0', builds: '3.0.0' },
      devDependencies: { 'test-tool': '2.0.0' },
    };
    const fetcher = (async (input: string | URL | Request) => {
      const body = archives.get(
        typeof input === 'string' ? input : String(input),
      );
      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(body);
    }) as typeof fetch;
    return runWith(
      {
        'package.json': JSON.stringify(manifest),
        'package-lock.json': JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: { '': manifest, ...packages },
        }),
      },
      argv,
      { fetch: fetcher },
    );
  };
}
