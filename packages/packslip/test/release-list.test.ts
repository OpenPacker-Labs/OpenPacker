import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openpacker/contracts';
import {
  PackslipError,
  assertListFresh,
  assertListSequence,
  decodeReleaseList,
} from '../src/index.js';

const URL_A = 'https://dl.example.com/2026.9.1/packslip.sigstore.json';
const URL_B = 'https://dl.example.com/2026.9.0/packslip.sigstore.json';
const hex = (digit: string) => digit.repeat(64);

function list(
  over: Record<string, JsonValue> = {},
  predicate: Record<string, JsonValue> = {},
): JsonValue {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      { name: URL_A, digest: { sha256: hex('a'), sha512: 'b'.repeat(128) } },
      { name: URL_B, digest: { sha256: hex('c') } },
    ],
    predicateType: 'https://packslip.dev/releases/v1',
    predicate: {
      project: 'mise.jdx.dev',
      generated_at: '2026-09-01T12:00:00Z',
      expires_at: '2026-10-01T12:00:00Z',
      sequence: 42,
      latest: '2026.9.1',
      identity: { scheme: 'sigstore-key', key_id: '5A0A0B8B9C6D7E1F' },
      releases: [
        {
          version: '2026.9.1',
          tag: 'v2026.9.1',
          published_at: '2026-09-01T12:00:00Z',
          packslip: URL_A,
          security: true,
        },
        {
          version: '2026.9.0',
          tag: 'v2026.9.0',
          published_at: '2026-08-20T12:00:00Z',
          packslip: URL_B,
          status: 'yanked',
          status_reason: 'CVE-2026-1234',
        },
      ],
      ...predicate,
    },
    ...over,
  };
}

/** The document with one predicate field left out, as a signer that forgot it would write it. */
function drop(document: JsonValue, field: string): JsonValue {
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  )
    return document;
  const predicate = document.predicate;
  if (
    typeof predicate !== 'object' ||
    predicate === null ||
    Array.isArray(predicate)
  )
    return document;
  const { [field]: _removed, ...rest } = predicate;
  return { ...document, predicate: rest };
}

describe('decoding a signed release list', () => {
  it('reads the specification’s own example', () => {
    const decoded = decodeReleaseList(list());
    expect(decoded).toMatchObject({
      project: 'mise.jdx.dev',
      sequence: 42,
      latest: '2026.9.1',
      identity: {
        scheme: 'sigstore-key',
        keyId: '5A0A0B8B9C6D7E1F',
        pinWorkflow: true,
      },
    });
    expect(decoded.releases[0]).toMatchObject({
      version: '2026.9.1',
      tag: 'v2026.9.1',
      security: true,
      yanked: false,
    });
    expect(decoded.releases[1]).toMatchObject({
      yanked: true,
      statusReason: 'CVE-2026-1234',
    });
    expect(decoded.subjects[0]).toMatchObject({
      name: URL_A,
      sha256: hex('a'),
    });
  });

  it('treats a status it does not know as not withdrawn', () => {
    const decoded = decodeReleaseList(
      list(
        { subject: [{ name: URL_A, digest: { sha256: hex('a') } }] },
        {
          releases: [
            {
              version: '1.0.0',
              published_at: '2026-09-01T12:00:00Z',
              packslip: URL_A,
              status: 'recommended',
            },
          ],
          latest: '1.0.0',
        },
      ),
    );
    expect(decoded.releases[0]?.yanked).toBe(false);
  });

  it.each([
    [
      'the wrong predicate type',
      list({ predicateType: 'https://packslip.dev/release/v1' }),
      /predicateType/u,
    ],
    [
      'an invalid project',
      list({}, { project: 'https://mise.jdx.dev' }),
      /project/u,
    ],
    ['a negative sequence', list({}, { sequence: -1 }), /sequence/u],
    ['a fractional sequence', list({}, { sequence: 1.5 }), /sequence/u],
    ['a string sequence', list({}, { sequence: '42' }), /sequence/u],
    [
      'no expiry',
      drop(list(), 'expires_at'),
      /expires_at must be a non-empty string/u,
    ],
    [
      'an expiry that is not a timestamp',
      list({}, { expires_at: 'soon' }),
      /expires_at/u,
    ],
    [
      'a non-semver release version',
      drop(
        list(
          {},
          {
            releases: [
              {
                version: 'v1',
                published_at: '2026-09-01T12:00:00Z',
                packslip: URL_A,
              },
            ],
          },
        ),
        'latest',
      ),
      /semantic version/u,
    ],
    [
      'a latest that is not listed',
      list({}, { latest: '9.9.9' }),
      /latest 9.9.9 is not a listed version/u,
    ],
    [
      'a latest spelled as a tag',
      list({}, { latest: 'v2026.9.1' }),
      /not a listed version/u,
    ],
    [
      'a release with no subject digest',
      list({ subject: [{ name: URL_A, digest: { sha256: hex('a') } }] }),
      /no subject digest/u,
    ],
    [
      'a subject that is no listed release',
      list({
        subject: [
          { name: URL_A, digest: { sha256: hex('a') } },
          { name: URL_B, digest: { sha256: hex('c') } },
          { name: 'https://x.test/other', digest: { sha256: hex('d') } },
        ],
      }),
      /not a listed release/u,
    ],
    [
      'the same version twice',
      drop(
        list(
          {},
          {
            releases: [
              {
                version: '1.0.0',
                published_at: '2026-09-01T12:00:00Z',
                packslip: URL_A,
              },
              {
                version: '1.0.0',
                published_at: '2026-09-01T12:00:00Z',
                packslip: URL_B,
              },
            ],
          },
        ),
        'latest',
      ),
      /listed twice/u,
    ],
    [
      'a digest that is not lowercase hex',
      list({
        subject: [
          { name: URL_A, digest: { sha256: 'A'.repeat(64) } },
          { name: URL_B, digest: { sha256: hex('c') } },
        ],
      }),
      /lowercase hexadecimal/u,
    ],
  ])('refuses %s', (_label, document, because) => {
    try {
      decodeReleaseList(document);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PackslipError);
      expect(String(error)).toMatch(because);
    }
  });
});

describe('freshness and rollback', () => {
  const decoded = decodeReleaseList(list());
  const now = new Date('2026-09-15T00:00:00Z');

  it('accepts a list until the instant it expires, and refuses it from then on', () => {
    expect(() => assertListFresh(decoded, now)).not.toThrow();
    expect(() =>
      assertListFresh(decoded, new Date('2026-10-01T11:59:59Z')),
    ).not.toThrow();
    expect(() =>
      assertListFresh(decoded, new Date('2026-10-01T12:00:00Z')),
    ).toThrow(expect.objectContaining({ code: 'LIST_EXPIRED' }));
    expect(() =>
      assertListFresh(decoded, new Date('2027-01-01T00:00:00Z')),
    ).toThrow(expect.objectContaining({ code: 'LIST_EXPIRED' }));
  });

  it('refuses a sequence below the highest accepted, and allows the same one again', () => {
    expect(() => assertListSequence(decoded, undefined)).not.toThrow();
    expect(() => assertListSequence(decoded, 41)).not.toThrow();
    expect(() => assertListSequence(decoded, 42)).not.toThrow();
    expect(() => assertListSequence(decoded, 43)).toThrow(
      expect.objectContaining({ code: 'LIST_ROLLBACK' }),
    );
  });
});
