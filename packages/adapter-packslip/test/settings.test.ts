import { describe, expect, it } from 'vitest';
import { decodeSettings, EMPTY_SETTINGS } from '../src/index.js';
import { generateTestKey } from '@openpacker/packslip-testkit';

const PIN = 'ps1_snirenkjwr7m5ozgcufameodnm';

describe('decoding project settings', () => {
  it('means nothing configured when nothing is given', () => {
    expect(decodeSettings(undefined)).toBe(EMPTY_SETTINGS);
    expect(decodeSettings({})).toEqual(EMPTY_SETTINGS);
  });

  it('reads a keyless signer: pins, identity, issuer, and source repository', () => {
    const settings = decodeSettings({
      trust: {
        'github.com/jdx/hk': {
          pin: PIN,
          identity_prefix: 'https://github.com/jdx/hk/',
          issuer: 'https://token.actions.githubusercontent.com',
          source_repository: 'https://github.com/jdx/hk',
        },
        'example.com/tool': { pin: [PIN, 'ps1_kwhjac5qpc45qetfh6ppwisi6a'] },
      },
    });
    expect(settings.signers['github.com/jdx/hk']).toEqual({
      pins: [PIN],
      identityPrefix: 'https://github.com/jdx/hk/',
      issuer: 'https://token.actions.githubusercontent.com',
      sourceRepository: 'https://github.com/jdx/hk',
    });
    expect(settings.signers['example.com/tool']?.pins).toHaveLength(2);
  });

  it('keys a project’s trust by its lower-cased name, whatever case it was written in', () => {
    const settings = decodeSettings({
      trust: { 'github.com/jdx/HK': { pin: [PIN] } },
    });
    expect(Object.keys(settings.signers)).toEqual(['github.com/jdx/hk']);
  });

  it('reads a key-signed project with its public key and unlogged opt-in', () => {
    const key = generateTestKey();
    expect(
      decodeSettings({
        trust: {
          'example.com/tool': {
            public_key: key.publicKeyFile,
            allow_unlogged: true,
          },
        },
      }).signers['example.com/tool'],
    ).toEqual({ publicKey: key.publicKeyFile, allowUnlogged: true });
  });

  it('reads this run’s approvals and the host-compatibility override', () => {
    expect(
      decodeSettings({
        approvals: ['0123456789abcdef'],
        allow_incompatible_host: true,
      }),
    ).toMatchObject({
      approvals: ['0123456789abcdef'],
      allowIncompatibleHost: true,
    });
    expect(decodeSettings({ approvals: 'abc' }).approvals).toEqual(['abc']);
  });

  it.each([
    [
      'an unknown top-level setting',
      { surprise: true },
      /unknown setting "surprise"/u,
    ],
    [
      'a misspelled key, which would silently drop a pin',
      { trust: { 'example.com/tool': { pins: [PIN] } } },
      /unknown key "pins"/u,
    ],
    [
      'a project name that is not one',
      { trust: { 'not a project': { pin: PIN } } },
      /Invalid project name/u,
    ],
    [
      'a malformed fingerprint',
      { trust: { 'example.com/tool': { pin: 'ps2_abc' } } },
      /not a signer fingerprint/u,
    ],
    [
      'a fingerprint with the wrong casing',
      { trust: { 'example.com/tool': { pin: PIN.toUpperCase() } } },
      /not a signer fingerprint/u,
    ],
    [
      'a public key that is not minisign',
      { trust: { 'example.com/tool': { public_key: 'AAAA' } } },
      /minisign/u,
    ],
    [
      'a public key beside a keyless identity',
      {
        trust: {
          'example.com/tool': {
            public_key: generateTestKey().publicKeyFile,
            issuer: 'https://x.example',
          },
        },
      },
      /combines a public key/u,
    ],
    [
      'a non-boolean allow_unlogged',
      { trust: { 'example.com/tool': { allow_unlogged: 'yes' } } },
      /allow_unlogged must be a boolean/u,
    ],
    [
      'an empty string',
      { trust: { 'example.com/tool': { identity: '' } } },
      /non-empty string/u,
    ],
    [
      'a table that is a string',
      { trust: { 'example.com/tool': 'ps1_x' } },
      /must be a table/u,
    ],
    ['trust that is not a table', { trust: [] }, /trust must be a table/u],
    [
      'two entries for one project that differ only by case',
      {
        trust: {
          'github.com/jdx/hk': { pin: [PIN] },
          'github.com/jdx/HK': { pin: [PIN] },
        },
      },
      /differ only by case/u,
    ],
    ['a numeric approval', { approvals: [1] }, /non-empty string/u],
    [
      'a string allow_incompatible_host',
      { allow_incompatible_host: 'true' },
      /must be a boolean/u,
    ],
  ])('refuses %s', (_why, raw, because) => {
    expect(() => decodeSettings(raw)).toThrow(because);
  });
});
