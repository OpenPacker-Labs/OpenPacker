import { describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  CargoCodec,
  CargoSparseProvider,
  type CargoIndexRecord,
} from './index.js';

/**
 * What a message says of text from a crate's sparse-index entry is one line.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

function provider(records: CargoIndexRecord[]) {
  return new CargoSparseProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/ev/il/evil',
          {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              records.map((record) => JSON.stringify(record)).join('\n'),
            ),
          },
        ],
      ]),
    ),
    { now: () => '2026-10-12T00:00:00Z' },
    'https://fixtures.test',
    'https://fixtures.test/crates',
  );
}

const record = (fields: Partial<CargoIndexRecord>): CargoIndexRecord => ({
  name: 'evil',
  vers: '1.0.0',
  deps: [],
  cksum: '1'.repeat(64),
  features: {},
  yanked: false,
  size: 12,
  ...fields,
});

async function messageOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('a crate coordinate that is not one', () => {
  it('is one line', () => {
    let message = '';
    try {
      new CargoCodec().parseNativeCoordinate(`bad name${FORGED}`);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/^Invalid Cargo coordinate: bad name/u);
    expect(holdsControl(message)).toBe(false);
  });
});

describe('a sparse-index entry that is not understood', () => {
  it('says a target it keeps natively in one line', async () => {
    const inspection = await provider([
      record({
        deps: [
          {
            name: 'dep',
            req: '^1',
            features: [],
            optional: false,
            default_features: true,
            target: `cfg(unix)${FORGED}`,
            kind: 'normal',
          },
        ],
      }),
    ]).inspect('pkg:cargo/evil@1.0.0');
    const meanings: string[] = [];
    for (const requirement of inspection.package.requirements)
      for (const loss of requirement.semanticLoss)
        meanings.push(loss.originalMeaning ?? '');
    expect(meanings.join('')).toContain('Cargo cfg expression cfg(unix)');
    for (const meaning of meanings) expect(holdsControl(meaning)).toBe(false);
  });

  it('says a version it cannot read in one line', async () => {
    const message = await messageOf(() =>
      provider([record({ vers: `1.0.0${FORGED}` })]).enumerate(
        'pkg:cargo/evil',
      ),
    );
    expect(message).toMatch(/^Invalid version: 1\.0\.0/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('says a version it does not hold in one line', async () => {
    const message = await messageOf(() =>
      provider([record({})]).inspect('pkg:cargo/evil@9.9.9'),
    );
    expect(message).toBe(
      'pkg:cargo/evil@9.9.9 is absent from the sparse index',
    );
  });
});

describe('a dependency whose target is not text', () => {
  it('keeps the cfg expression it said when the target is an array', async () => {
    const inspection = await provider([
      record({
        deps: [
          {
            name: 'dep',
            req: '^1',
            features: [],
            optional: false,
            default_features: true,
            target: JSON.parse('{"v":["x"]}').v,
            kind: 'normal',
          },
        ],
      }),
    ]).inspect('pkg:cargo/evil@1.0.0');
    const meanings: string[] = [];
    for (const requirement of inspection.package.requirements)
      for (const loss of requirement.semanticLoss)
        meanings.push(loss.originalMeaning ?? '');
    expect(meanings).toContain(
      'Cargo cfg expression x is preserved for a native validator',
    );
  });
});
