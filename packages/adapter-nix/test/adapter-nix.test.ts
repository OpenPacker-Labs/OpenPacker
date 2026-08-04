import { describe, expect, it } from 'vitest';
import {
  NixCodec,
  parseNarHash,
  parseStorePath,
  splitDerivationName,
} from '../src/index.js';

const codec = new NixCodec();

const provenance = {
  providerId: 'nix-store',
  endpoint: 'nix-store:local',
  retrievedAt: '2026-08-03T00:00:00Z',
  evaluationTime: '2026-08-03T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
};

// A store hash uses nixbase32: no e, o, u, or t.
const OUT_HASH = 'b3f2q8xr7k1v5m9n0p4s6w2y4z6a8c1d';
const DEV_HASH = 'e1a0m3d5f7g9h1j3k5l7n9p1r3v5x9zb'.replace(/[eout]/gu, 'q');
const LIBC_HASH = 'c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n';
const PLAN_HASH = '97ml2f4h6j8k0n2p4r6v0x2z4b6d8f1s';

describe('nix store paths', () => {
  it('splits names the way Nix does', () => {
    // The version starts at the first hyphen followed by a non-letter.
    expect(splitDerivationName('libgreet-1.0')).toEqual({
      name: 'libgreet',
      version: '1.0',
    });
    expect(splitDerivationName('python3-3.12.1')).toEqual({
      name: 'python3',
      version: '3.12.1',
    });
    // A hyphenated word is part of the name, not a version.
    expect(splitDerivationName('nix-info')).toEqual({ name: 'nix-info' });
    expect(splitDerivationName('gcc-wrapper-13.2.0')).toEqual({
      name: 'gcc-wrapper',
      version: '13.2.0',
    });
  });

  it('parses full and bare store paths, including derivations', () => {
    expect(parseStorePath(`/nix/store/${OUT_HASH}-libgreet-1.0`)).toEqual({
      hash: OUT_HASH,
      name: 'libgreet',
      version: '1.0',
      isDerivation: false,
    });
    expect(
      parseStorePath(`/nix/store/${PLAN_HASH}-libgreet-1.0.drv`).isDerivation,
    ).toBe(true);
    expect(() => parseStorePath('/usr/lib/libgreet.so')).toThrow(
      /Not a Nix store path/,
    );
    // A hash outside nixbase32 is not a store path.
    expect(() =>
      parseStorePath(`/nix/store/${'e'.repeat(32)}-x-1.0`),
    ).toThrow();
  });
});

describe('nix PURL canonicalization', () => {
  it('defaults the output qualifier and keeps store hashes', () => {
    const purl = codec.canonicalizePurl(
      `pkg:nix/libgreet@1.0?outhash=${OUT_HASH}&plan=${PLAN_HASH}`,
    );
    expect(purl).toContain('output=out');
    expect(purl).toContain(`outhash=${OUT_HASH}`);
    expect(purl).toContain(`plan=${PLAN_HASH}`);
    // Canonicalization is idempotent.
    expect(codec.canonicalizePurl(purl)).toBe(purl);
  });

  it('rejects namespaces and malformed store hashes', () => {
    expect(() => codec.canonicalizePurl('pkg:nix/scope/libgreet@1.0')).toThrow(
      /no namespace/,
    );
    expect(() =>
      codec.canonicalizePurl('pkg:nix/libgreet@1.0?outhash=tooshort'),
    ).toThrow(/store hash/);
    expect(() => codec.canonicalizePurl('pkg:npm/demo@1.0.0')).toThrow(
      /Expected a nix PURL/,
    );
  });
});

describe('nix versions', () => {
  it('orders components numerically then lexically', () => {
    // Nix compares component-wise; 10 is greater than 9, unlike a string sort.
    expect(codec.compareNativeVersions('1.10', '1.9')).toBe(1);
    expect(codec.compareNativeVersions('1.0', '1.0')).toBe(0);
    expect(codec.compareNativeVersions('2405', '2311')).toBe(1);
    // A numeric component outranks an alphabetic one.
    expect(codec.compareNativeVersions('1.1', '1.a')).toBe(1);
    // Pre-release markers sort before the bare release.
    expect(codec.compareNativeVersions('1.0pre1', '1.0')).toBe(-1);
  });

  it('accepts versions semver would reject', () => {
    // Nix versions are not semver: a single component or a date is normal.
    for (const version of ['2405', '1.0', '3.12.1', '0.1.0-unstable']) {
      const parsed = codec.parseNativeVersion(version);
      expect(parsed.original).toBe(version);
      expect(parsed.normalized).toBe(version);
    }
    expect(() => codec.parseNativeVersion('  ')).toThrow();
  });

  it('represents requirements as exact versions and says when it lost meaning', () => {
    const exact = codec.parseNativeRange('1.0');
    expect(exact.vers).toBe('vers:nix/1.0');
    expect(exact.reversible).toBe(true);
    expect(exact.semanticLoss).toEqual([]);
    expect(codec.satisfies('1.0', exact)).toBe(true);
    expect(codec.satisfies('1.1', exact)).toBe(false);

    // Nix has no range syntax, so anything range-shaped loses meaning rather
    // than being silently reinterpreted.
    const range = codec.parseNativeRange('>=1.0');
    expect(range.reversible).toBe(false);
    expect(range.semanticLoss[0]?.code).toBe('NIX_RANGE_NOT_REPRESENTED');
  });
});

describe('nix path-info translation', () => {
  const entry = {
    path: `/nix/store/${OUT_HASH}-libgreet-1.0`,
    output: 'out',
    deriver: `/nix/store/${PLAN_HASH}-libgreet-1.0.drv`,
    narHash: `sha256:${'5'.repeat(64)}`,
    narSize: 49152,
    references: [
      `/nix/store/${OUT_HASH}-libgreet-1.0`,
      `/nix/store/${LIBC_HASH}-glibc-2.39`,
    ],
  };

  it('maps a store entry onto an exact PURL with hash qualifiers', async () => {
    const { instance } = await codec.translateMetadata(entry, provenance);
    expect(instance.identity.exactPurl).toContain('pkg:nix/libgreet@1.0');
    expect(instance.identity.qualifiers.outhash).toBe(OUT_HASH);
    expect(instance.identity.qualifiers.output).toBe('out');
    expect(instance.identity.qualifiers.plan).toBe(PLAN_HASH);
    expect(instance.identity.canonicalPurl).toBe('pkg:nix/libgreet');
    expect(instance.identity.nativeCoordinates[0]?.coordinate).toBe(entry.path);
  });

  it('records the store hash as opaque and the expression as unevaluated', async () => {
    const { instance } = await codec.translateMetadata(entry, provenance);
    const codes = instance.semanticLoss.map((item) => item.code);
    expect(codes).toContain('NIX_STORE_PATH_HASH_OPAQUE');
    expect(codes).toContain('NIX_EXPRESSION_NOT_EVALUATED');
  });

  it('turns references into requirements and drops the self reference', async () => {
    const { instance } = await codec.translateMetadata(entry, provenance);
    expect(instance.requirements).toHaveLength(1);
    const expression = instance.requirements[0]?.expression as {
      purl: string;
      qualifiers: Record<string, string>;
    };
    expect(expression.purl).toBe('pkg:nix/glibc');
    expect(expression.qualifiers.outhash).toBe(LIBC_HASH);
    expect(instance.requirements[0]?.kind).toBe('runtime');
  });

  it('uses the store hash as the version when a name carries none', async () => {
    const { instance } = await codec.translateMetadata(
      { ...entry, path: `/nix/store/${OUT_HASH}-nix-info` },
      provenance,
    );
    // Never invent 0.0.0: the hash is exact and unique.
    expect(instance.identity.version).toBe(OUT_HASH);
    expect(instance.semanticLoss.map((item) => item.code)).toContain(
      'NIX_UNVERSIONED_NAME',
    );
  });

  it('declares the realised output', async () => {
    const { instance } = await codec.translateMetadata(entry, provenance);
    expect(instance.outputs).toEqual([
      expect.objectContaining({ name: 'out', default: true }),
    ]);
    const dev = await codec.translateMetadata(
      { ...entry, path: `/nix/store/${DEV_HASH}-libgreet-1.0`, output: 'dev' },
      provenance,
    );
    expect(dev.instance.outputs?.[0]).toEqual(
      expect.objectContaining({ name: 'dev', default: false }),
    );
    // Sibling outputs share a plan but never a node identity.
    expect(dev.instance.identity.qualifiers.plan).toBe(PLAN_HASH);
    expect(dev.instance.nodeId).not.toBe(
      (await codec.translateMetadata(entry, provenance)).instance.nodeId,
    );
  });

  it('rejects an entry without a store path', async () => {
    await expect(codec.translateMetadata({}, provenance)).rejects.toThrow(
      /needs a path/,
    );
  });
});

describe('nar hashes', () => {
  it('accepts both spellings sha256 can take', () => {
    expect(parseNarHash(`sha256:${'a'.repeat(64)}`)).toEqual({
      algorithm: 'sha256',
      value: 'a'.repeat(64),
    });
    const base64 = Buffer.from('b'.repeat(32), 'binary').toString('base64');
    expect(parseNarHash(`sha256-${base64}`)?.algorithm).toBe('sha256');
  });

  it('refuses algorithms PREX cannot represent', () => {
    // SRI with a non-sha256 algorithm must not be coerced into a PREX digest.
    expect(parseNarHash('sha512-abcdef')).toBeUndefined();
    expect(parseNarHash('md5:abc')).toBeUndefined();
    expect(parseNarHash(undefined)).toBeUndefined();
  });
});

describe('nix closure capture', () => {
  it('captures a closure as an exact, already-resolved set', () => {
    const capture = codec.translateLockResult(
      [
        {
          path: `/nix/store/${OUT_HASH}-libgreet-1.0`,
          narHash: `sha256:${'5'.repeat(64)}`,
          references: [`/nix/store/${LIBC_HASH}-glibc-2.39`],
        },
        { path: `/nix/store/${LIBC_HASH}-glibc-2.39`, references: [] },
      ],
      provenance,
    );
    expect(capture.format).toBe('nix-path-info');
    expect(capture.packages).toHaveLength(2);
    expect(capture.packages[0]?.exactPurl).toContain('pkg:nix/libgreet@1.0');
    expect(capture.packages[0]?.artifactDigest).toBe(
      `sha256:${'5'.repeat(64)}`,
    );
    expect(capture.packages[0]?.dependencies).toEqual({ glibc: LIBC_HASH });
    // Capture never claims the expressions were evaluated.
    expect(capture.semanticLoss.map((item) => item.code)).toContain(
      'NIX_EXPRESSION_NOT_EVALUATED',
    );
  });

  it('refuses an empty closure', () => {
    expect(() => codec.translateLockResult([], provenance)).toThrow(
      /at least one store path/,
    );
  });
});
