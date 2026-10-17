/**
 * No place in `packages/*` or `apps/*` hands text that a registry, a lock, a
 * manifest or a network peer chose to a URL parser without asking the guard
 * first.
 *
 * Node's `new URL` takes the square of the length of a special scheme's host
 * when it is made of many non-ASCII labels (65,550 characters hold the process
 * for 0.7 s here; ADR 0044), and no such host is a DNS name. So every such place
 * reads the text with `parseUntrustedUrl` (`@openpacker/canonical`), which
 * refuses a host longer than 253 characters before the parser sees it. That is
 * a property of the call sites, so it is read from the sources with the
 * TypeScript parser (`untrusted-url-scan.ts`): a new `new URL(`, `URL.canParse`,
 * `fileURLToPath(text)`, `fetch(text)` or `new Request(text)` fails here, and
 * the few that remain are named below with the reason each may stay. An entry
 * that no longer matches what the file does fails too, so the list cannot
 * outlive the code it excuses.
 *
 * What it does not see: a parse behind a function that is not named here
 * (`GUARDED` in the scanner names the three that return a guarded `URL`), and a
 * URL read by something that is not JavaScript.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUrlUses } from './untrusted-url-scan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') &&
      !/\.(?:test|fixture|mistakes|d)\.ts$/u.test(entry.name)
      ? [path]
      : [];
  });
}

/** `src` of every package and app. */
function productionSources(): string[] {
  return ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(root, group, entry.name, 'src')).sort()
        : [],
    ),
  );
}

interface Reviewed {
  file: string;
  how: string;
  count: number;
  reason: string;
}

/** What may parse a URL without the guard, by file and the way, with the reason. */
const REVIEWED: readonly Reviewed[] = [
  {
    file: 'packages/canonical/src/untrusted-url.ts',
    how: 'new URL',
    count: 2,
    reason:
      'the guard itself: each is after `hasOverlongHost` has been asked of the same text, the base included',
  },
  {
    file: 'packages/adapter-core/src/redact-address.ts',
    how: 'new URL',
    count: 1,
    reason:
      '`redactAddress` asks `hasOverlongHost` of the address as written before anything is parsed, and a `blob:` address it recurses into is part of that text',
  },
  {
    file: 'packages/adapter-packslip/src/network.ts',
    how: 'new URL',
    count: 1,
    reason: 'maps the five GitHub origins written in the file above it',
  },
  {
    file: 'packages/adapter-npm/src/pnpm-lock/fixture-support.ts',
    how: 'new URL',
    count: 3,
    reason:
      "test support: resolves the repository's own pnpm-lock fixtures against this file's URL, and is handed no registry's or lock's text",
  },
  {
    file: 'packages/packslip-testkit/src/world.ts',
    how: 'new URL',
    count: 1,
    reason:
      "a test double: it turns the URL a test scripted into the key of the scripted web, and is handed no registry's text",
  },
  {
    file: 'packages/opm-project/src/catalog.ts',
    how: 'fileURLToPath',
    count: 1,
    reason:
      'reached only after the text begins `file:///` or `file://localhost/`, which fixes the host; only the path is variable, and a path is read in linear time',
  },
  {
    file: 'packages/opm-project/src/install.ts',
    how: 'fetch',
    count: 1,
    reason:
      '`assertReadableUrl` has read the same source, through the guard, on the line above',
  },
];

interface Place {
  file: string;
  how: string;
  statement: string;
  line: number;
}

function usesInTree(): Place[] {
  return productionSources().flatMap((path) =>
    findUrlUses(readFileSync(path, 'utf8'), path).map((use) => ({
      ...use,
      file: relative(root, path).split(sep).join('/'),
    })),
  );
}

describe('every place that parses a URL out of someone else’s text', () => {
  const places = usesInTree();

  it('reads the production sources of the packages and the apps', () => {
    const files = new Set(places.map((place) => place.file));
    // The ones that are allowed are found, so the scan reaches the tree.
    for (const entry of REVIEWED) expect(files.has(entry.file)).toBe(true);
    expect(productionSources().length).toBeGreaterThan(250);
  });

  it('asks the guard first, or is named below with the reason it need not', () => {
    const unreviewed = places.filter(
      (place) =>
        !REVIEWED.some(
          (entry) => entry.file === place.file && entry.how === place.how,
        ),
    );
    expect(
      unreviewed.map(
        (place) =>
          `${place.file}:${place.line} ${place.how}: ${place.statement}`,
      ),
    ).toEqual([]);
  });

  it('names no place that is gone or that has changed its count', () => {
    for (const entry of REVIEWED) {
      const here = places.filter(
        (place) => place.file === entry.file && place.how === entry.how,
      );
      expect(here.length, `${entry.file} (${entry.how}): ${entry.reason}`).toBe(
        entry.count,
      );
    }
  });
});

describe('the scanner', () => {
  const hows = (text: string): string[] =>
    findUrlUses(text).map((use) => use.how);

  it.each([
    ['new URL', 'const u = new URL(text);', ['new URL']],
    ['with a base', 'const u = new URL(text, base);', ['new URL']],
    ['on globalThis', 'const u = new globalThis.URL(text);', ['new URL']],
    ['through a namespace', 'const u = new url.URL(text);', ['new URL']],
    ['in parentheses', 'const u = new (URL)(text);', ['new URL']],
    ['canParse', 'const ok = URL.canParse(text);', ['URL.canParse']],
    ['parse', 'const u = URL.parse(text);', ['URL.parse']],
    [
      'through globalThis',
      'const u = globalThis.URL.parse(text);',
      ['URL.parse'],
    ],
    ['an alias', 'const U = URL; const u = new U(text);', ['URL as a value']],
    [
      'a constructor handed on',
      'const u = Reflect.construct(URL, [text]);',
      ['URL as a value'],
    ],
    ['an array of it', 'const all = [URL];', ['URL as a value']],
    [
      'a property of globalThis',
      'const U = globalThis.URL;',
      ['.URL as a value'],
    ],
    [
      'an import under another name',
      "import { URL as Address } from 'node:url';",
      ['import { URL }'],
    ],
    ['an import', "import { URL } from 'node:url';", ['import { URL }']],
    [
      'a file URL from text',
      'const p = fileURLToPath(text);',
      ['fileURLToPath'],
    ],
    [
      'a file URL parsed on the spot',
      'const p = fileURLToPath(new URL(text));',
      ['new URL', 'fileURLToPath'],
    ],
    ['a global fetch of text', 'const r = await fetch(text);', ['fetch']],
    ['a request from text', 'const r = new Request(text);', ['new Request']],
  ])('catches %s', (_name, text, expected) => {
    expect(hows(text).sort()).toEqual([...expected].sort());
  });

  it.each([
    ['the guard', 'const u = parseUntrustedUrl(text);'],
    ['the guard with a base', 'const u = parseUntrustedUrl(text, base);'],
    ['an instanceof', 'const is = value instanceof URL;'],
    [
      'an instanceof on globalThis',
      'const is = value instanceof globalThis.URL;',
    ],
    ['a type', 'function f(url: URL, all: Array<URL>): URL { return url; }'],
    ['a type query', 'type Constructor = typeof URL;'],
    ['a key of that name', 'const x = { URL: 1 };'],
    [
      'a file URL of a guarded call',
      'const p = fileURLToPath(parseUntrustedUrl(text));',
    ],
    [
      'a file URL of a named guard',
      'const p = fileURLToPath(assertReadableUrl(text, "read"));',
    ],
    [
      'this module’s own address',
      'const here = fileURLToPath(import.meta.url);',
    ],
    ['a fetch of a method', 'const r = await this.fetch(url);'],
    ['an injected fetch', 'const r = await options.fetch(url);'],
    ['a path made a file URL', 'const u = pathToFileURL(path).href;'],
  ])('lets %s through', (_name, text) => {
    expect(hows(text)).toEqual([]);
  });
});
