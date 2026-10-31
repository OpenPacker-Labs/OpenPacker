import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  memberTableExcess,
  PARSE_COSTS,
  parseCanonicalJsonCosted,
} from '@openpacker/canonical';
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
 * document must cost at most `HEADROOM` of the limit it is read under, and
 * every packument kept in this repository must be read.
 */

const MiB = 1024 * 1024;

/**
 * The share of its limit a real packument may cost: 85 percent. It was four
 * fifths until an object's member table was charged at its size (ADR 0044,
 * "The member table charged"); `@wix/wix-code-types`' full packument then costs
 * 83.1 percent of its limit, where what its parse needs at the peak is 196 MiB.
 */
const HEADROOM = 0.85;

/** The objects of each member count in a tree: `objects[i]` of `members[i]`. */
interface MemberCounts {
  readonly members: readonly number[];
  readonly objects: readonly number[];
}

const SURVEYED_MEMBER_COUNTS = (
  JSON.parse(
    readFileSync(
      new URL('./packument-survey-objects.json', import.meta.url),
      'utf8',
    ),
  ) as { documents: Record<string, MemberCounts> }
).documents;

/** What the parser charges for a tree of this composition (`PARSE_COSTS.peak`). */
function treeCost(
  row: Omit<SurveyedPackument, 'name' | 'document' | 'bytes'>,
  { members, objects }: MemberCounts,
) {
  const { peak } = PARSE_COSTS;
  return (
    objects.reduce(
      (total, count, index) =>
        total + count * memberTableExcess(members[index]!),
      0,
    ) +
    row.objects * peak.object +
    row.arrays * peak.array +
    (row.arrays - row.emptyArrays) * peak.firstElement +
    row.elements * peak.element +
    row.members * peak.member +
    row.bigMembers * peak.bigMember +
    row.keyChars * peak.nameCharacter +
    row.strings * peak.string +
    (row.stringChars + row.wideChars) * peak.character +
    row.heapNumbers * peak.heapNumber
  );
}

const keyOf = (row: SurveyedPackument) => `${row.name} ${row.document}`;
const costOf = (row: SurveyedPackument) =>
  treeCost(row, SURVEYED_MEMBER_COUNTS[keyOf(row)]!);

const limitOf = (row: SurveyedPackument) =>
  row.document === 'abbreviated'
    ? PACKUMENT_PARSE_COST
    : FULL_PACKUMENT_PARSE_COST;

describe('the real packuments, surveyed 2026-10-17', () => {
  it('include the ones the limits were set against', () => {
    const names = SURVEYED_PACKUMENTS.map(keyOf);
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

  it.each(SURVEYED_PACKUMENTS.map((row) => [keyOf(row), row] as const))(
    'costs at most 85 percent of its limit, and is under its byte bound: %s',
    (_, row) => {
      const cost = costOf(row);
      expect(
        cost,
        `${(cost / MiB).toFixed(1)} MiB of ${(limitOf(row) / MiB).toFixed(0)}`,
      ).toBeLessThanOrEqual(HEADROOM * limitOf(row));
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
      ).map(costOf),
    );
    expect(costOf(renovate)).toBe(heaviest);
    // 1 / HEADROOM is the requirement; this is what there is.
    expect(PACKUMENT_PARSE_COST / heaviest).toBeGreaterThan(1.95);
    // The abbreviated document of that composition at the byte bound: the
    // byte bound, and not the cost, is what stops a real packument.
    expect(
      (costOf(renovate) * MAXIMUM_PACKUMENT_BYTES) / renovate.bytes,
    ).toBeLessThan(PACKUMENT_PARSE_COST);
  });

  it('leave the tightest full one, wix-code-types, with its headroom stated', () => {
    const heaviest = Math.max(
      ...SURVEYED_PACKUMENTS.filter((row) => row.document === 'full').map(
        costOf,
      ),
    );
    const wix = SURVEYED_PACKUMENTS.find(
      (row) => row.name === '@wix/wix-code-types' && row.document === 'full',
    )!;
    expect(costOf(wix)).toBe(heaviest);
    expect(heaviest).toBeLessThanOrEqual(HEADROOM * FULL_PACKUMENT_PARSE_COST);
    // Over four fifths of the limit only because of the member tables.
    expect(heaviest).toBeGreaterThan(0.8 * FULL_PACKUMENT_PARSE_COST);
  });
});

describe('the member counts of the surveyed packuments', () => {
  it.each(SURVEYED_PACKUMENTS.map((row) => [keyOf(row), row] as const))(
    'add up to the composition of %s',
    (key, row) => {
      const { members, objects } = SURVEYED_MEMBER_COUNTS[key]!;
      expect(members).toHaveLength(objects.length);
      const sum = (each: (count: number, index: number) => number) =>
        objects.reduce((total, count, index) => total + each(count, index), 0);
      expect(sum((count) => count)).toBe(row.objects);
      expect(sum((count, index) => count * members[index]!)).toBe(row.members);
      expect(
        sum((count, index) => count * Math.max(0, members[index]! - 4096)),
      ).toBe(row.bigMembers);
    },
  );
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
      heapNumbers: 0,
    };
    const tables = new Map<number, number>();
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'number') {
        if (value < -(2 ** 30) || value >= 2 ** 30) row.heapNumbers += 1;
      } else if (typeof value === 'string') {
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
        tables.set(keys.length, (tables.get(keys.length) ?? 0) + 1);
        row.members += keys.length;
        row.bigMembers += Math.max(0, keys.length - 4096);
        for (const key of keys) {
          row.keyChars += key.length;
          pending.push((value as Record<string, unknown>)[key]);
        }
      }
    }
    const counts = {
      members: [...tables.keys()],
      objects: [...tables.values()],
    };
    return { row, counts };
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
        numbers: [1, 1073741823, 1073741824, -1073741825, 9007199254740991],
        nested: { x: { y: { z: {} } } },
        tables: [3, 4, 6, 7, 21, 22, 86].map((members) =>
          Object.fromEntries(
            Array.from({ length: members }, (_, i) => [`m${i}`, i]),
          ),
        ),
      }),
    ];
    for (const text of documents) {
      const parsed = parseCanonicalJsonCosted(text);
      const { row, counts } = composition(JSON.parse(text));
      expect(treeCost(row, counts)).toBe(parsed.cost);
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
