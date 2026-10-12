import { describe, expect, it } from 'vitest';
import {
  PackslipError,
  checkFingerprint,
  checkForge,
  decodeReleaseStatement,
  fingerprintOf,
  isFingerprint,
  parseProject,
  selectArtifact,
  selectResources,
  survivingIndexes,
  versionFromTag,
  type Artifact,
} from '../src/index.js';
import { vectors, type Json } from './vectors.js';

interface FingerprintCase {
  name: string;
  kind: 'derive' | 'parse' | 'check';
  issuer?: string;
  repository_id?: string | null;
  pin?: string;
  expect: string | null;
}

describe('upstream conformance: signer fingerprints', () => {
  for (const vector of vectors<FingerprintCase>('signer-fingerprint').cases) {
    it(vector.name, () => {
      if (vector.kind === 'derive') {
        expect(
          fingerprintOf(
            vector.issuer ?? '',
            vector.repository_id ?? undefined,
          ) ?? null,
        ).toBe(vector.expect);
      } else if (vector.kind === 'parse') {
        expect(isFingerprint(vector.pin ?? '') ? 'valid' : 'invalid').toBe(
          vector.expect,
        );
      } else {
        expect(
          checkFingerprint(
            vector.pin ?? '',
            vector.issuer ?? '',
            vector.repository_id ?? undefined,
          ),
        ).toBe(vector.expect);
      }
    });
  }
});

interface TagCase {
  name: string;
  tag: string;
  project: string;
  expect: string | null;
}

describe('upstream conformance: tag versions', () => {
  for (const vector of vectors<TagCase>('tag-versions').cases) {
    it(vector.name, () => {
      expect(
        versionFromTag(parseProject(vector.project), vector.tag) ?? null,
      ).toBe(vector.expect);
    });
  }
});

interface StatementCase {
  name: string;
  expect: 'accept' | 'reject';
  statement: Json;
  reason?: string;
}

/**
 * The upstream vectors say a document is refused, not which rule refuses it.
 * Pinning the rule here keeps a reject case from passing because an unrelated
 * check happened to fire.
 */
const REJECTED_BECAUSE: Record<string, RegExp> = {
  'a pin_workflow that is not a boolean': /pin_workflow must be a boolean/u,
  'the wrong predicate type': /predicateType must be/u,
  'a version that is not semver': /not a semantic version/u,
  'a project name with a scheme': /URL scheme/u,
  'a project host with no dot': /host must be lowercase and contain a dot/u,
  'an empty path segment in the project name': /empty path segment/u,
  'no artifacts': /artifacts must not be empty/u,
  'an artifact that no subject pins': /has no subject digest/u,
  'two artifacts with the same name': /appears twice/u,
  'two artifacts a consumer could not choose between':
    /shares os, arch, libc, variant, and format/u,
  'a published_at that is not a timestamp': /RFC 3339 UTC timestamp/u,
  'an uppercase token': /lowercase token/u,
  'an executable name that is a path': /command name, not a path/u,
  'exec completion cannot use a static single-shell declaration':
    /lists every shell/u,
  'exec completion needs a shell placeholder': /substitutes \{shell\}/u,
};

describe('upstream conformance: statement validity', () => {
  for (const vector of vectors<StatementCase>('statement-validity').cases) {
    it(`${vector.expect}: ${vector.name}`, () => {
      if (vector.expect === 'accept') {
        expect(() => decodeReleaseStatement(vector.statement)).not.toThrow();
        return;
      }
      const because = REJECTED_BECAUSE[vector.name];
      expect(because, `no reason pinned for "${vector.name}"`).toBeDefined();
      expect(() => decodeReleaseStatement(vector.statement)).toThrow(
        PackslipError,
      );
      expect(() => decodeReleaseStatement(vector.statement)).toThrow(
        because ?? /unreachable/u,
      );
    });
  }
});

interface ArtifactCase {
  name: string;
  host: { os: string; arch: string; libc: string | null };
  variant: string | null;
  formats: string[];
  artifacts: Json;
  expect: { artifact?: string; error?: string };
}

describe('upstream conformance: artifact selection', () => {
  for (const vector of vectors<ArtifactCase>('artifact-selection').cases) {
    it(vector.name, () => {
      // SAFETY: Vector artifacts are committed fixtures in the decoded Artifact shape.
      const artifacts = vector.artifacts as unknown as Artifact[];
      const request = {
        host: {
          os: vector.host.os,
          arch: vector.host.arch,
          ...(vector.host.libc !== null && { libc: vector.host.libc }),
        },
        ...(vector.variant !== null && { variant: vector.variant }),
        formats: vector.formats,
      };
      if (vector.expect.artifact !== undefined) {
        expect(selectArtifact(artifacts, request).artifact.name).toBe(
          vector.expect.artifact,
        );
      } else {
        const code =
          vector.expect.error === 'ambiguous'
            ? 'AMBIGUOUS_ARTIFACT'
            : 'NO_ARTIFACT';
        expect(() => selectArtifact(artifacts, request)).toThrow(
          expect.objectContaining({ code }),
        );
      }
    });
  }
});

interface ResourceCase {
  name: string;
  artifact: string;
  statement: Json;
  expect: number[];
}

describe('upstream conformance: resource selection', () => {
  for (const vector of vectors<ResourceCase>('resource-selection').cases) {
    it(vector.name, () => {
      const statement = decodeReleaseStatement(vector.statement);
      const artifact = statement.artifacts.find(
        (a) => a.name === vector.artifact,
      );
      expect(artifact).toBeDefined();
      if (artifact === undefined) return;
      expect(survivingIndexes(selectResources(statement, artifact))).toEqual(
        vector.expect,
      );
    });
  }
});

interface ForgeCase {
  name: string;
  pin: { project: string; repository_id?: string };
  requested: string;
  release: {
    project: string;
    signer: string;
    certificate: { uri?: string; id?: string };
  };
  previous_signer?: string;
  expect: {
    outcome: 'same' | 'renamed' | 'refuse';
    reason?: string;
    signer_continues?: boolean;
  };
}

describe('upstream conformance: forge identity', () => {
  for (const vector of vectors<ForgeCase>('forge-identity').cases) {
    it(vector.name, () => {
      const result = checkForge(
        {
          project: vector.pin.project,
          ...(vector.pin.repository_id !== undefined && {
            repositoryId: vector.pin.repository_id,
          }),
        },
        vector.requested,
        {
          project: vector.release.project,
          signer: vector.release.signer,
          certificate: {
            ...(vector.release.certificate.uri !== undefined && {
              uri: vector.release.certificate.uri,
            }),
            ...(vector.release.certificate.id !== undefined && {
              id: vector.release.certificate.id,
            }),
          },
        },
        vector.previous_signer,
      );
      expect(result.outcome).toBe(vector.expect.outcome);
      if (result.outcome === 'refuse')
        expect(result.reason).toBe(vector.expect.reason);
      else if (vector.expect.signer_continues !== undefined)
        expect(result.signerContinues).toBe(vector.expect.signer_continues);
    });
  }
});
