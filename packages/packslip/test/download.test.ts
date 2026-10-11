import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openpacker/contracts';
import {
  PackslipError,
  checkArtifactBytes,
  checkDigest,
  decodeReleaseStatement,
  fetchArtifact,
  subjectFor,
} from '../src/index.js';
import { FakeWeb } from './support/world.js';

const bytes = Buffer.from('the signed bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sha512 = createHash('sha512').update(bytes).digest('hex');

function statement(extra: { sha512?: string; size?: number } = {}) {
  const document: JsonValue = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'tool.tar.gz',
        digest: {
          sha256,
          ...(extra.sha512 !== undefined && { sha512: extra.sha512 }),
        },
      },
    ],
    predicateType: 'https://packslip.dev/release/v1',
    predicate: {
      project: 'example.com/tool',
      version: '1.0.0',
      published_at: '2026-09-01T00:00:00Z',
      artifacts: [
        {
          name: 'tool.tar.gz',
          size: extra.size ?? bytes.length,
          format: 'tar.gz',
        },
      ],
      identity: { scheme: 'sigstore-key', key_id: 'AAAA' },
    },
  };
  return decodeReleaseStatement(document);
}

function refusal(action: () => void): PackslipError {
  try {
    action();
  } catch (error) {
    if (error instanceof PackslipError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('checking bytes against the signature', () => {
  it('accepts exactly the signed bytes, with or without a sha512', () => {
    expect(() =>
      checkArtifactBytes(statement(), statement().artifacts[0]!, bytes),
    ).not.toThrow();
    expect(() =>
      checkArtifactBytes(
        statement({ sha512 }),
        statement({ sha512 }).artifacts[0]!,
        bytes,
      ),
    ).not.toThrow();
  });

  it('refuses one changed byte', () => {
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 1;
    expect(
      refusal(() =>
        checkArtifactBytes(statement(), statement().artifacts[0]!, tampered),
      ).code,
    ).toBe('DIGEST_MISMATCH');
  });

  it('refuses a different size before it looks at the digest', () => {
    const longer = Buffer.concat([bytes, Buffer.from('!')]);
    expect(
      refusal(() =>
        checkArtifactBytes(statement(), statement().artifacts[0]!, longer),
      ).code,
    ).toBe('SIZE_MISMATCH');
    expect(
      refusal(() =>
        checkArtifactBytes(
          statement(),
          statement().artifacts[0]!,
          Buffer.alloc(0),
        ),
      ).code,
    ).toBe('SIZE_MISMATCH');
  });

  it('refuses when only the sha512 disagrees, so a weak sha256 collision alone is not enough', () => {
    const wrong = statement({ sha512: 'f'.repeat(128) });
    const error = refusal(() =>
      checkArtifactBytes(wrong, wrong.artifacts[0]!, bytes),
    );
    expect(error.code).toBe('DIGEST_MISMATCH');
    expect(error.message).toContain('sha512');
  });

  it('checks a digest on its own when no size is given', () => {
    expect(() => checkDigest({ name: 'x', sha256 }, bytes)).not.toThrow();
    expect(
      refusal(() => checkDigest({ name: 'x', sha256: 'a'.repeat(64) }, bytes))
        .code,
    ).toBe('DIGEST_MISMATCH');
  });

  it('knows no digest for a file the statement does not list', () => {
    expect(
      refusal(() => subjectFor(statement(), 'other.tar.gz')).message,
    ).toContain('nothing signs its bytes');
  });
});

describe('fetching an artifact', () => {
  const release = statement();
  const artifact = release.artifacts[0]!;
  const url = 'https://dl.example.com/tool.tar.gz';

  it('returns verified bytes', async () => {
    const web = new FakeWeb().set(url, bytes);
    expect(
      Buffer.from(await fetchArtifact(web, release, artifact, url)).equals(
        bytes,
      ),
    ).toBe(true);
  });

  it('refuses tampered bytes', async () => {
    const web = new FakeWeb().set(url, Buffer.from('the signed bytez'));
    await expect(
      fetchArtifact(web, release, artifact, url),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('refuses a server answering with an error', async () => {
    const web = new FakeWeb().set(url, 'nope', 503);
    await expect(
      fetchArtifact(web, release, artifact, url),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      fetchArtifact(new FakeWeb(), release, artifact, url),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('never reads more than the signed size', async () => {
    const web = new FakeWeb().set(
      url,
      Buffer.concat([bytes, Buffer.alloc(1000)]),
    );
    await expect(fetchArtifact(web, release, artifact, url)).rejects.toThrow(
      /byte limit/u,
    );
  });
});
