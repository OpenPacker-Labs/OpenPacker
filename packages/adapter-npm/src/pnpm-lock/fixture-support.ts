/**
 * The lockfiles under `fixtures/locks/pnpm-v9/`, read for the tests. See that
 * directory's README for where each came from.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIRECTORY = new URL(
  '../../../../fixtures/locks/pnpm-v9/',
  import.meta.url,
);

export const FIXTURES = [
  'ai-bdd.pnpm-lock.yaml',
  'hobo.cut.pnpm-lock.yaml',
  'opensesame.cut.pnpm-lock.yaml',
  'exotic.pnpm-lock.yaml',
  'long-key.pnpm-lock.yaml',
] as const;

export type FixtureName = (typeof FIXTURES)[number];

export function fixtureBytes(name: FixtureName): Buffer {
  return readFileSync(new URL(name, DIRECTORY));
}

export function fixtureText(name: FixtureName): string {
  return fixtureBytes(name).toString('utf8');
}

export function fixtureSha256(name: FixtureName): string {
  return createHash('sha256').update(fixtureBytes(name)).digest('hex');
}

/** What an independent reading of each fixture (Python and PyYAML, none of this reader's logic) counted. */
export interface ExpectedCounts {
  readonly sha256: string;
  readonly importers: number;
  readonly packages: number;
  readonly snapshots: number;
  readonly dependencyEdges: { importers: number; snapshots: number };
  readonly linkEdges: { importers: number; snapshots: number };
  readonly aliasEdges: { importers: number; snapshots: number };
  readonly exoticSources: {
    tarball: number;
    git: number;
    directory: number;
    runtime: number;
  };
  readonly multiVersionNames: { name: string; versions: string[] }[];
  readonly platformRestricted: {
    key: string;
    os?: string[];
    cpu?: string[];
    libc?: string[];
  }[];
  readonly orphanPackages: string[];
  readonly orphanSnapshots: string[];
  readonly danglingEdges: number;
  readonly snapshotsWithoutPackage: number;
  readonly patchedSnapshots: number;
  readonly peerSuffixedSnapshots: number;
  readonly deepestPeerNesting: number;
}

export function expectedCounts(name: FixtureName): ExpectedCounts {
  const all: Record<string, ExpectedCounts> = JSON.parse(
    readFileSync(new URL('expected.json', DIRECTORY), 'utf8'),
  );
  const counts = all[name];
  if (counts === undefined) throw new Error(`no expected counts for ${name}`);
  return counts;
}

/** The text with the blocks of `importers`, `packages` and `snapshots` in the opposite order. */
export function withBlocksReversed(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let section = '';
  let blocks: string[][] = [];
  const flush = () => {
    for (const block of blocks.reverse()) out.push(...block);
    blocks = [];
  };
  for (const line of lines) {
    const top = /^([A-Za-z]+):/u.exec(line);
    if (top !== null) {
      flush();
      section = top[1] ?? '';
      out.push(line);
    } else if (
      ['importers', 'packages', 'snapshots'].includes(section) &&
      /^ {2}(?!: )[^ #]/u.test(line)
    ) {
      blocks.push([line]);
    } else if (blocks.length > 0) {
      blocks.at(-1)?.push(line);
    } else out.push(line);
  }
  flush();
  return out.join('\n');
}
