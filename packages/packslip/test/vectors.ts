import { readFileSync } from 'node:fs';
import type { JsonValue } from '@openpacker/contracts';

export interface VectorFile<Case> {
  readonly rule: string;
  readonly description: string;
  readonly cases: readonly Case[];
}

/** An upstream conformance vector file, parsed but otherwise untouched. */
export function vectors<Case>(file: string): VectorFile<Case> {
  const url = new URL(`./fixtures/conformance/${file}.json`, import.meta.url);
  // SAFETY: The vector files are committed fixtures whose shape each test asserts below.
  return JSON.parse(readFileSync(url, 'utf8')) as VectorFile<Case>;
}

export type Json = JsonValue;
