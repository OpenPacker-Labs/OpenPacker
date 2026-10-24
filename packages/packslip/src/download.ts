import { createHash } from 'node:crypto';
import { PackslipError } from './errors.js';
import type { Fetcher } from './fetch.js';
import type { Artifact, ReleaseStatement, Subject } from './types.js';
import { shown } from './shown.js';

export function subjectFor(statement: ReleaseStatement, name: string): Subject {
  const subject = statement.subjects.find(
    (candidate) => candidate.name === name,
  );
  if (subject === undefined)
    throw new PackslipError(
      'INVALID_STATEMENT',
      `${shown(name)} is not a subject of the release, so nothing signs its bytes`,
    );
  return subject;
}

/**
 * Check downloaded bytes against what the signer committed to: the size, the
 * SHA-256, and the SHA-512 when the statement carries one. A file that differs
 * is not the file the signer described, whatever else about the release
 * verified.
 */
export function checkDigest(
  subject: Subject,
  bytes: Uint8Array,
  expectedSize?: number,
): void {
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize)
    throw new PackslipError(
      'SIZE_MISMATCH',
      `${shown(subject.name)} is ${bytes.byteLength} bytes; the signed size is ${expectedSize}`,
    );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== subject.sha256)
    throw new PackslipError(
      'DIGEST_MISMATCH',
      `${shown(subject.name)} has sha256 ${sha256}, not the signed ${subject.sha256}`,
    );
  if (subject.sha512 !== undefined) {
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    if (sha512 !== subject.sha512)
      throw new PackslipError(
        'DIGEST_MISMATCH',
        `${shown(subject.name)} has sha512 ${sha512}, not the signed ${subject.sha512}`,
      );
  }
}

export function checkArtifactBytes(
  statement: ReleaseStatement,
  artifact: Artifact,
  bytes: Uint8Array,
): void {
  checkDigest(subjectFor(statement, artifact.name), bytes, artifact.size);
}

/**
 * Fetch an artifact and verify it. The signed size bounds the download, so a
 * hostile server cannot make a consumer read more than the signer said exists.
 */
export async function fetchArtifact(
  fetcher: Fetcher,
  statement: ReleaseStatement,
  artifact: Artifact,
  url: string,
): Promise<Uint8Array> {
  const response = await fetcher.get(url, { maxBytes: artifact.size });
  if (response.status !== 200)
    throw new PackslipError(
      'UNAVAILABLE',
      `${url} answered ${response.status} for ${shown(artifact.name)}`,
    );
  checkArtifactBytes(statement, artifact, response.bytes);
  return response.bytes;
}
