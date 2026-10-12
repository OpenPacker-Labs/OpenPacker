import { describe, expect, it } from 'vitest';
import { decodeRecord } from '../src/index.js';

const valid = {
  project: 'github.com/jdx/hk',
  version: '2.5.0',
  bundle_digest: `sha256:${'a'.repeat(64)}`,
  artifact: 'hk.tar.gz',
  attested_by: 'vendor',
  logged: true,
  provenance: false,
  signer: {
    scheme: 'sigstore-oidc',
    identity: '.github/workflows/release.yml',
    issuer: 'https://token.actions.githubusercontent.com',
    repository_id: '922514152',
    pin_workflow: true,
  },
  list: { sequence: 7 },
};

describe('reading back what the lock kept', () => {
  it('restores the remembered signer, how it was attested, and the list sequence', () => {
    expect(decodeRecord(valid)).toEqual({
      memory: {
        project: 'github.com/jdx/hk',
        signer: {
          scheme: 'sigstore-oidc',
          identity: '.github/workflows/release.yml',
          issuer: 'https://token.actions.githubusercontent.com',
          repositoryId: '922514152',
          pinWorkflow: true,
        },
        attestedBy: 'vendor',
        logged: true,
        provenance: false,
      },
      list: { used: true, sequence: 7 },
    });
  });

  it('treats a release with no list as one that never used a list', () => {
    const { list: _gone, ...without } = valid;
    expect(decodeRecord(without).list).toEqual({});
  });

  it('assumes the stronger default for an omitted workflow pin', () => {
    const { pin_workflow: _gone, ...signer } = valid.signer;
    expect(decodeRecord({ ...valid, signer }).memory.signer.pinWorkflow).toBe(
      true,
    );
  });

  it.each([
    ['not an object', 'text'],
    ['no signer', { ...valid, signer: undefined }],
    [
      'an unknown signature scheme',
      { ...valid, signer: { ...valid.signer, scheme: 'pgp' } },
    ],
    ['an unknown attestation', { ...valid, attested_by: 'nobody' }],
    [
      'a signer with no identity',
      { ...valid, signer: { scheme: 'sigstore-key' } },
    ],
    [
      'a list with a non-integer sequence',
      { ...valid, list: { sequence: 'x' } },
    ],
    ['no project', { ...valid, project: undefined }],
  ])(
    'refuses a record that is %s, rather than forgetting what it held',
    (_why, record) => {
      expect(() =>
        decodeRecord(JSON.parse(JSON.stringify(record ?? null))),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    },
  );
});
