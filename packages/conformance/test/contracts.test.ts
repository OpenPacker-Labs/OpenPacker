import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize, parseCanonicalJson } from '@openpacker/canonical';
import {
  PREX_CONFORMANCE_LEVELS,
  schemaCatalog,
  type JsonValue,
} from '@openpacker/contracts';
import { runConformanceVectors, type ConformanceVector } from '../src/index.js';

interface VectorIndex {
  vectors: Array<{
    name: string;
    file?: string;
    inline?: JsonValue;
    pointer?: string;
    mutations?: Array<{
      operation: 'delete' | 'set';
      path: string;
      value?: JsonValue;
    }>;
    schema: string;
    valid: boolean;
    levels: string[];
  }>;
}

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../../../fixtures/protocol',
);

describe('PREX protocol vectors', () => {
  it(
    'matches every positive and negative schema expectation',
    { timeout: 60_000 },
    async () => {
      const index = JSON.parse(
        await readFile(
          path.join(fixtureRoot, 'conformance-vectors.json'),
          'utf8',
        ),
      ) as VectorIndex;
      const vectors: ConformanceVector[] = await Promise.all(
        index.vectors.map(async (vector) => {
          let value = vector.file
            ? (JSON.parse(
                await readFile(path.join(fixtureRoot, vector.file), 'utf8'),
              ) as JsonValue)
            : (vector.inline as JsonValue);
          if (vector.pointer) value = atPointer(value, vector.pointer);
          value = structuredClone(value);
          for (const mutation of vector.mutations ?? [])
            mutate(value, mutation);
          return {
            name: vector.name,
            schema: vector.schema,
            valid: vector.valid,
            levels: vector.levels,
            value,
          };
        }),
      );
      const results = runConformanceVectors(vectors);
      const failures = results.filter(
        (result) => result.actualValid !== result.valid,
      );
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      for (const result of results.filter((item) => item.valid)) {
        const canonical = canonicalize(result.value);
        expect(canonicalize(parseCanonicalJson(canonical))).toBe(canonical);
      }
      for (const schema of Object.keys(schemaCatalog)) {
        const matching = results.filter(
          (result) => result.schema.split('#', 1)[0] === schema,
        );
        expect(
          matching.some((result) => result.valid),
          schema,
        ).toBe(true);
        expect(
          matching.some((result) => !result.valid),
          schema,
        ).toBe(true);
      }
      for (const level of PREX_CONFORMANCE_LEVELS) {
        const matching = results.filter((result) =>
          result.levels.includes(level),
        );
        expect(
          matching.some((result) => result.valid),
          `${level} positive`,
        ).toBe(true);
        expect(
          matching.some((result) => !result.valid),
          `${level} negative`,
        ).toBe(true);
      }
    },
  );
});

function atPointer(value: JsonValue, pointer: string): JsonValue {
  let current = value;
  for (const part of pointerParts(pointer)) {
    if (typeof current !== 'object' || current === null || !(part in current))
      throw new Error(`Invalid conformance vector pointer: ${pointer}`);
    current = (current as Record<string, JsonValue>)[part]!;
  }
  return current;
}

function mutate(
  value: JsonValue,
  mutation: {
    operation: 'delete' | 'set';
    path: string;
    value?: JsonValue;
  },
): void {
  const parts = pointerParts(mutation.path);
  const key = parts.pop();
  if (!key) throw new Error('Mutation path must select a property');
  let parent = value;
  for (const part of parts) {
    if (typeof parent !== 'object' || parent === null || !(part in parent))
      throw new Error(`Invalid mutation path: ${mutation.path}`);
    parent = (parent as Record<string, JsonValue>)[part]!;
  }
  if (typeof parent !== 'object' || parent === null)
    throw new Error(`Invalid mutation parent: ${mutation.path}`);
  if (mutation.operation === 'delete')
    delete (parent as Record<string, JsonValue>)[key];
  else (parent as Record<string, JsonValue>)[key] = mutation.value ?? null;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/'))
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}
