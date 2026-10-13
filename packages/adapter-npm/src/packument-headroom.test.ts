import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PARSE_COSTS, parseCanonicalJsonCosted } from '@openpacker/canonical';
import { json } from '@openpacker/adapter-core';
import {
  FULL_PACKUMENT_LIMITS,
  FULL_PACKUMENT_PARSE_COST,
  MAXIMUM_FULL_PACKUMENT_BYTES,
  MAXIMUM_PACKUMENT_BYTES,
  PACKUMENT_LIMITS,
  PACKUMENT_PARSE_COST,
} from './packument-limits.js';
import {
  SURVEYED_PACKUMENTS,
  type SurveyedPackument,
} from './packument-survey.js';

/**
 * The cost limits are held against the packuments that exist. A limit that
 * refuses `renovate` is a limit that breaks `opm add renovate`, so each real
 * document must cost at most four fifths of the limit it is read under (25
 * percent headroom), and every packument kept in this repository must be read.
 */

const MiB = 1024 * 1024;

/** What the parser charges for a tree of this composition (`PARSE_COSTS.peak`). */
function treeCost(row: Omit<SurveyedPackument, 'name' | 'document' | 'bytes'>) {
  const { peak } = PARSE_COSTS;
  return (
    row.objects * peak.object +
    row.arrays * peak.array +
    (row.arrays - row.emptyArrays) * peak.firstElement +
    row.elements * peak.element +
    row.members * peak.member +
    row.bigMembers * peak.bigMember +
    row.keyChars * peak.nameCharacter +
    row.strings * peak.string +
    (row.stringChars + row.wideChars) * peak.character
  );
}

const limitOf = (row: SurveyedPackument) =>
  row.document === 'abbreviated'
    ? PACKUMENT_PARSE_COST
    : FULL_PACKUMENT_PARSE_COST;

describe('the real packuments, surveyed 2026-10-12', () => {
  it('include the ones the limits were set against', () => {
    const names = SURVEYED_PACKUMENTS.map(
      (row) => `${row.name} ${row.document}`,
    );
    for (const wanted of [
      'next abbreviated',
      'renovate abbreviated',
      'renovate full',
      '@prisma/client abbreviated',
      '@wix/wix-code-types abbreviated',
      '@wix/wix-code-types full',
    ])
      expect(names).toContain(wanted);
  });

  it.each(
    SURVEYED_PACKUMENTS.map(
      (row) => [`${row.name} ${row.document}`, row] as const,
    ),
  )(
    'costs at most four fifths of its limit, and is under its byte bound: %s',
    (_, row) => {
      const cost = treeCost(row);
      expect(
        cost * 1.25,
        `${(cost / MiB).toFixed(0)} MiB of ${(limitOf(row) / MiB).toFixed(0)}`,
      ).toBeLessThanOrEqual(limitOf(row));
      expect(row.bytes).toBeLessThanOrEqual(
        row.document === 'abbreviated'
          ? MAXIMUM_PACKUMENT_BYTES
          : MAXIMUM_FULL_PACKUMENT_BYTES,
      );
    },
  );

  it('leave the tightest abbreviated one, renovate, with its headroom stated', () => {
    const renovate = SURVEYED_PACKUMENTS.find(
      (row) => row.name === 'renovate' && row.document === 'abbreviated',
    )!;
    const heaviest = Math.max(
      ...SURVEYED_PACKUMENTS.filter(
        (row) => row.document === 'abbreviated',
      ).map(treeCost),
    );
    expect(treeCost(renovate)).toBe(heaviest);
    // 1.25 is the requirement; this is what there is.
    expect(PACKUMENT_PARSE_COST / heaviest).toBeGreaterThan(2);
    // The abbreviated document of that composition at the byte bound: the
    // byte bound, and not the cost, is what stops a real packument.
    expect(
      (treeCost(renovate) * MAXIMUM_PACKUMENT_BYTES) / renovate.bytes,
    ).toBeLessThan(PACKUMENT_PARSE_COST);
  });

  it('leave the tightest full one, wix-code-types, with its headroom stated', () => {
    const heaviest = Math.max(
      ...SURVEYED_PACKUMENTS.filter((row) => row.document === 'full').map(
        treeCost,
      ),
    );
    const wix = SURVEYED_PACKUMENTS.find(
      (row) => row.name === '@wix/wix-code-types' && row.document === 'full',
    )!;
    expect(treeCost(wix)).toBe(heaviest);
    expect(FULL_PACKUMENT_PARSE_COST / heaviest).toBeGreaterThanOrEqual(1.25);
  });
});

describe('the cost of a tree of a given composition', () => {
  /** Count a parsed tree as the survey counted the real ones. */
  function composition(root: unknown) {
    const row = {
      objects: 0,
      arrays: 0,
      emptyArrays: 0,
      members: 0,
      bigMembers: 0,
      keyChars: 0,
      elements: 0,
      strings: 0,
      stringChars: 0,
      wideChars: 0,
    };
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        row.strings += 1;
        row.stringChars += value.length;
        if (/[\u{100}-\u{10ffff}]/u.test(value)) row.wideChars += value.length;
      } else if (Array.isArray(value)) {
        row.arrays += 1;
        if (value.length === 0) row.emptyArrays += 1;
        row.elements += value.length;
        pending.push(...value);
      } else if (typeof value === 'object' && value !== null) {
        const keys = Object.keys(value);
        row.objects += 1;
        row.members += keys.length;
        row.bigMembers += Math.max(0, keys.length - 4096);
        for (const key of keys) {
          row.keyChars += key.length;
          pending.push((value as Record<string, unknown>)[key]);
        }
      }
    }
    return row;
  }

  it('is what the parser charges, so the survey rows say what the parser would', async () => {
    const packument = await readFile(
      new URL('../../../fixtures/catalogs/npm/packument.json', import.meta.url),
      'utf8',
    );
    const documents = [
      packument,
      JSON.stringify({
        a: [[], [1, 2, 3], [[]]],
        big: Object.fromEntries(
          Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]),
        ),
        strings: ['', 'abc', 'défg', 'wide €uro', 'x'.repeat(1000)],
        nested: { x: { y: { z: {} } } },
      }),
    ];
    for (const text of documents) {
      const parsed = parseCanonicalJsonCosted(text);
      expect(treeCost(composition(JSON.parse(text)))).toBe(parsed.cost);
    }
  });
});

/** Every JSON file in the repository outside what is installed or built. */
async function jsonFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ['node_modules', 'dist', '.git', 'target', '.turbo'].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await jsonFiles(path)));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

describe('the packuments kept in this repository', () => {
  it('are all read, under both limits', async () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const packuments: string[] = [];
    for (const path of await jsonFiles(root)) {
      const text = await readFile(path, 'utf8');
      if (text.includes('"dist-tags"') && text.includes('"versions"'))
        packuments.push(path);
    }
    expect(packuments.length).toBeGreaterThan(0);
    for (const path of packuments) {
      const response = {
        status: 200,
        headers: {},
        body: await readFile(path),
        url: 'https://registry.test/x',
      };
      expect(() => json(response, PACKUMENT_LIMITS), path).not.toThrow();
      expect(() => json(response, FULL_PACKUMENT_LIMITS), path).not.toThrow();
    }
  });
});
