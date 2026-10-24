import { describe, expect, it } from 'vitest';
import { ProviderError } from '@openpacker/adapter-core';
import { PackslipError } from '@openpacker/packslip';
import {
  PackslipCodec,
  createNetwork,
  decodeRecord,
  decodeSettings,
  parsePackslipPurl,
} from '../src/index.js';

/**
 * A lock, a project's settings and a PURL are text a repository chose, and the
 * artifacts a release names are the vendor's. What this adapter quotes of them
 * reaches a terminal, a log and a report, so it is plain text on one line:
 * whatever was written (an escape sequence that retitles the window, a line
 * break and a line that looks like opm's, NEL, a right-to-left override, a
 * zero-width space), a refusal is one line with none of it.
 */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
const ESC = chars(0x1b);
const BEL = chars(0x07);
const HOSTILE = [
  'evil',
  `${ESC}]0;retitled${BEL}`,
  'name',
  '\r\n',
  'opm: ok installed 1 package',
  chars(0x85, 0x202e, 0x200b),
  'X',
  `${ESC}[2K`,
].join('');
const UNSAFE = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([from, to]) => `\\u{${from!.toString(16)}}-\\u{${to!.toString(16)}}`)
    .join('')}]`,
  'u',
);

function expectPlainLine(error: Error | undefined): void {
  if (error === undefined) throw new Error('expected a refusal');
  expect(error.message).not.toMatch(UNSAFE);
  expect(error.message.length).toBeLessThan(600);
}

function thrown(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('what the adapter quotes of a lock, a manifest and a PURL', () => {
  it('in a native version and a coordinate', () => {
    const codec = new PackslipCodec();
    const version = thrown(() => codec.parseNativeVersion(HOSTILE));
    expect(version).toBeInstanceOf(ProviderError);
    expectPlainLine(version);
    expectPlainLine(
      thrown(() =>
        codec.parseNativeCoordinate(`github.com/acme/tool@${HOSTILE}`),
      ),
    );
  });

  it('in a PURL qualifier and a version', () => {
    expectPlainLine(thrown(() => parsePackslipPurl(`pkg:generic/${HOSTILE}`)));
    expectPlainLine(
      thrown(() =>
        parsePackslipPurl('pkg:packslip/github.com/acme/tool@1.0.0?x=1'),
      ),
    );
    expectPlainLine(
      thrown(() =>
        parsePackslipPurl(
          'pkg:packslip/github.com/acme/tool@1.0.0?variant=A B',
        ),
      ),
    );
  });

  it('in the settings of a project', () => {
    expectPlainLine(thrown(() => decodeSettings({ [HOSTILE]: 1 })));
    expectPlainLine(
      thrown(() =>
        decodeSettings({
          trust: { 'github.com/acme/tool': { [HOSTILE]: 'x' } },
        }),
      ),
    );
    expectPlainLine(
      thrown(() =>
        decodeSettings({
          trust: {
            'github.com/acme/tool': { pin: 5 },
            'GitHub.com/acme/tool': {},
          },
        }),
      ),
    );
  });

  it('in the attestation a lock kept', () => {
    const record = (scheme: string, attestedBy: string) => ({
      signer: { scheme, identity: 'x' },
      attested_by: attestedBy,
    });
    expectPlainLine(thrown(() => decodeRecord(record(HOSTILE, 'vendor'))));
    expectPlainLine(
      thrown(() => decodeRecord(record('sigstore-oidc', HOSTILE))),
    );
  });

  it('in the reason a download failed', async () => {
    const network = createNetwork({
      transport: {
        async request() {
          throw new Error(`socket closed ${HOSTILE}`);
        },
      },
    });
    let error: Error | undefined;
    try {
      await network.get('https://dl.example.com/x', { maxBytes: 100 });
    } catch (caught) {
      if (caught instanceof Error) error = caught;
    }
    expect(error).toBeInstanceOf(PackslipError);
    expectPlainLine(error);
    expect(error?.message).toContain('socket closed evil');
  });

  it('cut at 256 characters, with how long it was', () => {
    const long = 'k'.repeat(5000);
    const key = thrown(() => decodeSettings({ [long]: 1 }));
    expect(key.message.length).toBeLessThan(400);
    expect(key.message).toContain('5000 characters');
    const scheme = thrown(() =>
      decodeRecord({
        signer: { scheme: long, identity: 'x' },
        attested_by: 'vendor',
      }),
    );
    expect(scheme.message.length).toBeLessThan(400);
    expect(scheme.message).toContain('5000 characters');
  });
});
