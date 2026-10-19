import { describe, expect, it } from 'vitest';
import {
  OpmError,
  parseLockfile,
  reproducibleLockForm,
  serializeLockfile,
} from '../src/index.js';
import {
  CONFUSIONS,
  describePath,
  pathsOf,
  pick,
  replaced,
  seeded,
  type Json,
} from './type-confusion.js';

/**
 * A lock is a file in a cloned repository, so the reader meets any JSON. Every
 * field of a lock that holds every optional field is replaced, one at a time and
 * then in seeded combinations, by a value of each other type: the reader either
 * reads the lock or refuses it with `INVALID_LOCK`, and never throws what it did
 * not mean to (a `TypeError` is written as `opm: internal error: ...`).
 */
const FULL_LOCK: Json = {
  schemaVersion: 1,
  generatedBy: 'opm',
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  packages: {
    demo: {
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      digest: `sha256:${'b'.repeat(64)}`,
      size: 10,
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
      source: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
      storeKey: 'b'.repeat(64),
      bins: [
        { name: 'demo', path: 'bin/demo.js', interpreter: 'node', entry: 'x' },
      ],
      reason: 'direct',
      ecosystem: 'npm',
      dependencies: ['dep'],
      trustLevel: 'unsigned',
      publishedAt: '2026-01-01T00:00:00Z',
      registryId: 'https://registry.npmjs.org',
      sourceKind: 'registry',
      lifecycle: { status: 'published', eligible: true },
      nativeIntegrity: { algorithm: 'sha512', value: 'abc', encoding: 'sri' },
      attestation: {
        kind: 'packslip',
        signerIdentity: 'someone@example.test',
        issuer: 'https://issuer.example.test',
        signedAt: '2026-01-01T00:00:00Z',
        signedAtVerified: true,
        evidence: ['one'],
        record: { sequence: 1 },
        advancing: ['sequence'],
      },
    },
    dep: {
      purl: 'pkg:npm/dep@1.0.0',
      version: '1.0.0',
      digest: `sha256:${'c'.repeat(64)}`,
      size: 5,
      format: 'zip',
      mediaType: 'application/zip',
      source: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
      storeKey: 'c'.repeat(64),
      bins: [],
      reason: 'transitive',
      ecosystem: 'npm',
    },
  },
};

/** What reading a document may do with it: return a lock or refuse with the lock's code. */
function outcome(document: Json): 'read' | 'refused' | Error {
  try {
    const lock = parseLockfile(JSON.stringify(document));
    // What the commands do with a lock they have read.
    serializeLockfile(lock);
    reproducibleLockForm(lock, lock);
    return 'read';
  } catch (error) {
    if (error instanceof OpmError && error.code === 'INVALID_LOCK')
      return 'refused';
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe('the lock reader', () => {
  it('reads the lock that holds every field', () => {
    expect(outcome(FULL_LOCK)).toBe('read');
  });

  const paths = pathsOf(FULL_LOCK);

  it('has a path for every field, which is what the fuzz walks', () => {
    // 21 on the first package's own fields, 4 more under its bin and ...
    expect(paths.length).toBeGreaterThan(55);
  });

  it('refuses or reads a field of any other type, one field at a time', () => {
    const failures: string[] = [];
    for (const path of paths)
      for (const confusion of [undefined, ...CONFUSIONS]) {
        const result = outcome(replaced(FULL_LOCK, path, confusion));
        if (result instanceof Error)
          failures.push(
            `${describePath(path)} = ${JSON.stringify(confusion)}: ${result.name}: ${result.message}`,
          );
      }
    expect(failures).toEqual([]);
  });

  it('refuses or reads a lock with several fields of the wrong type, for 4000 seeded draws', () => {
    const random = seeded(0x1ee7);
    const failures: string[] = [];
    for (let draw = 0; draw < 4000; draw += 1) {
      let document = FULL_LOCK;
      const edits: string[] = [];
      const count = 2 + Math.floor(random() * 3);
      for (let edit = 0; edit < count; edit += 1) {
        const path = pick(pathsOf(document), random);
        const confusion = pick([undefined, ...CONFUSIONS], random);
        edits.push(`${describePath(path)} = ${JSON.stringify(confusion)}`);
        document = replaced(document, path, confusion);
      }
      const result = outcome(document);
      if (result instanceof Error)
        failures.push(`${edits.join('; ')}: ${result.name}: ${result.message}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
