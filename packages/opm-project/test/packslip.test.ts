import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeWeb,
  buildRelease,
  fakeFetch,
  generateTestKey,
  generateTestLog,
  githubWorld,
  type BuildOptions,
  type TestKey,
} from '@openpacker/packslip-testkit';
import {
  defaultSupplyChainPolicyInput,
  initProject,
  installFromLock,
  installProject,
  parseLockfile,
  parseManifest,
  parsePackageSpec,
  readLockfile,
  resolveManifestToLock,
  serializeLockfile,
  syncProject,
  updateProject,
  writeLockfile,
  writeManifestFile,
  type OpmManifest,
  type RegistryOptions,
} from '../src/index.js';

const PROJECT = 'github.com/acme/tool';
const BASE = `pkg:packslip/${PROJECT}`;
const NOW = '2026-10-11T00:00:00.000Z';
const lookup = async () => [{ address: '140.82.112.3', family: 4 as const }];

let key: TestKey;
let web: FakeWeb;
let network: ReturnType<typeof fakeFetch>;
let root: string;
const roots: string[] = [];

function newWorld(): void {
  web = new FakeWeb();
  network = fakeFetch(web);
}

function publish(
  versions: string[],
  over: Partial<BuildOptions> = {},
): ReturnType<typeof buildRelease>[] {
  const built = versions.map((version) =>
    buildRelease({
      project: PROJECT,
      version,
      key,
      baseUrl: `https://github.com/acme/tool/releases/download/v${version}`,
      // No os or arch: the release fits whatever machine runs this test.
      artifacts: [{}],
      ...over,
    }),
  );
  githubWorld(web, {
    repo: 'acme/tool',
    releases: built.map((release, index) => ({
      tag: `v${versions[index]}`,
      release,
    })),
  });
  return built;
}

function manifestText(extra = '', version = '^1.0.0'): string {
  return `
[project]
name = "demo"
ecosystems = ["packslip"]

[packages.tool]
purl = "${BASE}"
version = "${version}"

[adapters.packslip]
${extra}

[adapters.packslip.trust."${PROJECT}"]
public_key = "${key.publicKeyFile.split('\n').find((line) => !line.startsWith('untrusted'))}"
allow_unlogged = true

[options]
offline = false
layout = "opm"
`;
}

/**
 * The default policy, except that this tool is excused from the release-age
 * gate. An unlogged, key-signed release has no time anyone verified (the
 * statement's `published_at` is the signer's own word), so the gate cannot pass
 * it; a project that trusts such a vendor says so, exactly like this.
 */
const excused = (manifest: OpmManifest): OpmManifest => ({
  ...manifest,
  policy: {
    ...defaultSupplyChainPolicyInput(),
    minimumReleaseAgeExclude: [BASE],
  },
});

const registryOptions = (): RegistryOptions => ({
  fetch: network,
  lookup,
  now: () => NOW,
});

async function project(manifest: OpmManifest): Promise<void> {
  await initProject({ root, name: 'demo' });
  await writeManifestFile(join(root, 'opm.toml'), manifest);
}

beforeEach(async () => {
  key = generateTestKey();
  newWorld();
  root = await mkdtemp(join(tmpdir(), 'opm-packslip-'));
  roots.push(root);
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('a packslip-signed tool in an opm project', () => {
  it('is resolved, verified and locked with what was checked', async () => {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    const lock = await resolveManifestToLock({
      root,
      manifest,
      offline: false,
      registryOptions: registryOptions(),
    });
    const locked = lock.packages.tool;
    expect(locked).toMatchObject({
      purl: `${BASE}@1.0.0`,
      version: '1.0.0',
      ecosystem: 'packslip',
      reason: 'direct',
      format: 'tar+gzip',
      mediaType: 'application/gzip',
      source: expect.stringMatching(
        /^https:\/\/github\.com\/acme\/tool\/releases\/download\/v1\.0\.0\/tool-1\.0\.0-.*\.tar\.gz$/u,
      ),
      registryId: 'urn:openpacker:registry:packslip',
      sourceKind: 'registry',
      trustLevel: 'registry-attested',
      bins: [{ name: 'tool', path: 'tool/bin/tool', interpreter: 'native' }],
    });
    // The signed `published_at` is the signer's word, so it is not a clock.
    expect(locked?.publishedAt).toBeUndefined();
    expect(locked?.attestation).toMatchObject({
      kind: 'packslip',
      signerIdentity: key.keyId,
      signedAtVerified: false,
      evidence: ['packslip'],
      advancing: ['list'],
      record: {
        project: PROJECT,
        version: '1.0.0',
        signer: { scheme: 'sigstore-key', identity: key.keyId },
      },
    });
  });

  it('writes a lock that reads back exactly', async () => {
    publish(['1.0.0']);
    const lock = await resolveManifestToLock({
      root,
      manifest: excused(parseManifest(manifestText())),
      offline: false,
      registryOptions: registryOptions(),
    });
    const again = parseLockfile(serializeLockfile(lock));
    expect(again.packages.tool?.attestation).toEqual(
      lock.packages.tool?.attestation,
    );
  });

  it('installs the verified archive and its native executable', async () => {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    await project(manifest);
    const lock = await resolveManifestToLock({
      root,
      manifest,
      offline: false,
      registryOptions: registryOptions(),
    });
    const state = await installFromLock({
      root,
      lock,
      offline: false,
      ...(manifest.policy !== undefined && { policy: manifest.policy }),
    });
    const bin = state.packages.tool?.bins[0];
    expect(bin).toMatchObject({ name: 'tool', interpreter: 'native' });
    expect((await stat(bin?.target ?? '')).isFile()).toBe(true);
    expect(await readFile(bin?.target ?? '', 'utf8')).toBe(
      '#!/bin/sh\necho tool\n',
    );
  });

  it('makes the lock stale when the trust it was resolved under changes', async () => {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    await project(manifest);
    const lock = await resolveManifestToLock({
      root,
      manifest,
      offline: false,
      registryOptions: registryOptions(),
    });
    await writeLockfile(join(root, 'opm.lock.json'), lock);
    // Anyone who can change who is trusted changes the manifest digest, so a
    // frozen install refuses until the project is resolved again.
    await writeManifestFile(join(root, 'opm.toml'), {
      ...manifest,
      adapterSettings: {
        packslip: {
          ...manifest.adapterSettings?.packslip,
          allow_incompatible_host: true,
        },
      },
    });
    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      {
        code: 'INVALID_LOCK',
        message: expect.stringContaining(
          'not produced from the current manifest',
        ),
      },
    );
  });

  it('applies an accepted-signer policy to a packslip as it would to any registry', async () => {
    publish(['1.0.0']);
    const base = excused(parseManifest(manifestText()));
    const accepting = (identities: string[]): OpmManifest => ({
      ...base,
      policy: {
        ...defaultSupplyChainPolicyInput(),
        minimumReleaseAgeExclude: [BASE],
        acceptedSignerIdentityPatterns: identities,
      },
    });
    const resolveWith = (manifest: OpmManifest) =>
      resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: registryOptions(),
      });
    await expect(resolveWith(accepting([key.keyId]))).resolves.toBeDefined();
    await expect(
      resolveWith(accepting(['SOMEONE-ELSE'])),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('refuses a release when the project trusts a different key', async () => {
    publish(['1.0.0']);
    const other = generateTestKey();
    const manifest = excused(parseManifest(manifestText()));
    manifest.adapterSettings = {
      packslip: {
        trust: {
          [PROJECT]: {
            public_key: other.publicKeyFile,
            allow_unlogged: true,
          },
        },
      },
    };
    await expect(
      resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: registryOptions(),
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_VERIFICATION_FAILED' });
  });

  it('refuses a misspelled trust setting instead of trusting no one quietly', async () => {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    manifest.adapterSettings = {
      packslip: { trust: { [PROJECT]: { public_keys: key.publicKeyFile } } },
    };
    await expect(
      resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: registryOptions(),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PACKSLIP_INPUT',
      message: expect.stringContaining('unknown key "public_keys"'),
    });
  });

  it('has no verified time when nothing logged it, so the default release-age gate cannot pass it', async () => {
    // However old it says it is: the date is the signer's own word, and a
    // stolen key would write whatever date suits it.
    publish(['1.0.0'], { publishedAt: '2020-01-01T00:00:00Z' });
    await expect(
      resolveManifestToLock({
        root,
        manifest: parseManifest(manifestText()),
        offline: false,
        registryOptions: registryOptions(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
  });

  describe('with a transparency log whose time is verified', () => {
    const HOUR = 3600 * 1000;
    let trustedRootPath: string | undefined;
    const previous = process.env.OPM_PACKSLIP_TRUSTED_ROOT;

    // Policy evaluates against the real clock, so "too new" is relative to it.
    async function publishLogged(
      integratedTime: Date,
      over: Partial<BuildOptions> = {},
    ): Promise<void> {
      const log = generateTestLog();
      trustedRootPath = join(root, 'trusted_root.json');
      await writeFile(trustedRootPath, log.trustedRoot);
      process.env.OPM_PACKSLIP_TRUSTED_ROOT = trustedRootPath;
      publish(['1.0.0'], {
        logged: { log, integratedTime },
        // Backdated by the signer, as a stolen key would.
        publishedAt: '2020-01-01T00:00:00Z',
        ...over,
      });
    }

    afterEach(() => {
      if (previous === undefined) delete process.env.OPM_PACKSLIP_TRUSTED_ROOT;
      else process.env.OPM_PACKSLIP_TRUSTED_ROOT = previous;
    });

    const resolveIt = () =>
      resolveManifestToLock({
        root,
        manifest: parseManifest(manifestText()),
        offline: false,
        registryOptions: registryOptions(),
      });

    it('holds a release that is too new, whatever date the signer gave it', async () => {
      await publishLogged(new Date(Date.now() - 2 * HOUR));
      await expect(resolveIt()).rejects.toMatchObject({
        code: expect.stringMatching(/^POLICY_/u),
        message: expect.stringContaining('Release age 120m'),
      });
    });

    it('lets an old enough release through, aged from the log', async () => {
      await publishLogged(new Date('2026-10-08T00:00:00Z'));
      const lock = await resolveIt();
      expect(lock.packages.tool).toMatchObject({
        publishedAt: '2026-10-08T00:00:00.000Z',
        attestation: {
          signedAt: '2026-10-08T00:00:00.000Z',
          signedAtVerified: true,
          evidence: ['packslip', 'sigstore-transparency'],
        },
      });
    });
  });

  it('does not let a pinned key stand in for Sigstore evidence a policy asks for', async () => {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    await expect(
      resolveManifestToLock({
        root,
        manifest: {
          ...manifest,
          policy: {
            ...(manifest.policy ?? {
              allowYanked: false,
              allowQuarantined: false,
              semanticLossMaximum: 'warning',
              requiredEvidence: [],
            }),
            requiredEvidence: ['sigstore'],
          },
        },
        offline: false,
        registryOptions: registryOptions(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
    // Asking only for what a packslip verification does prove is satisfied.
    await expect(
      resolveManifestToLock({
        root,
        manifest: {
          ...manifest,
          policy: {
            ...(manifest.policy ?? {
              allowYanked: false,
              allowQuarantined: false,
              semanticLossMaximum: 'warning',
              requiredEvidence: [],
            }),
            requiredEvidence: ['packslip'],
          },
        },
        offline: false,
        registryOptions: registryOptions(),
      }),
    ).resolves.toBeDefined();
  });
});

describe('remembering who signed', () => {
  /** A project locked at 1.0.0, the only release there is. */
  async function lockedProject(): Promise<void> {
    publish(['1.0.0']);
    const manifest = excused(parseManifest(manifestText()));
    await project(manifest);
    const lock = await resolveManifestToLock({
      root,
      manifest,
      offline: false,
      registryOptions: registryOptions(),
    });
    expect(lock.packages.tool?.version).toBe('1.0.0');
    await writeFile(join(root, 'opm.lock.json'), serializeLockfile(lock));
  }

  /** The vendor ships 1.1.0, signed by `signer`, and the manifest trusts it. */
  async function release110(signer: TestKey, approvals: string[] = []) {
    key = signer;
    newWorld();
    publish(['1.0.0', '1.1.0']);
    await writeManifestFile(
      join(root, 'opm.toml'),
      excused(
        parseManifest(
          manifestText(
            approvals.length === 0
              ? ''
              : `approvals = [${approvals.map((id) => `"${id}"`).join(', ')}]`,
          ),
        ),
      ),
    );
  }

  const update = () =>
    updateProject({
      root,
      offline: false,
      registryOptions: registryOptions(),
    });
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (caught: Error) => caught,
    );

  it('accepts the next release from the same signer', async () => {
    await lockedProject();
    await release110(key);
    const result = await update();
    expect(result.lock.packages.tool?.version).toBe('1.1.0');
  });

  it('stops at a signer that changed, and says exactly what to approve', async () => {
    await lockedProject();
    await release110(generateTestKey());
    const error = await failure(update());
    expect(error).toMatchObject({ code: 'TRUST_CHANGE_REQUIRES_APPROVAL' });
    expect(error?.message).toMatch(/proposal [0-9a-f]{16}/u);
    expect(error?.message).toContain('key');
    // Nothing was written: the lock still says what it said.
    const kept = await readLockfile(join(root, 'opm.lock.json'));
    expect(kept?.packages.tool?.version).toBe('1.0.0');
  });

  it('accepts the change once a person approved that exact proposal', async () => {
    await lockedProject();
    const oldKeyId = key.keyId;
    const rotated = generateTestKey();
    await release110(rotated);
    const refused = await failure(update());
    const id = /proposal ([0-9a-f]{16})/u.exec(refused?.message ?? '')?.[1];
    expect(id).toBeDefined();

    await release110(rotated, [id ?? '']);
    const result = await update();
    expect(result.lock.packages.tool?.version).toBe('1.1.0');
    expect(result.lock.packages.tool?.attestation?.signerIdentity).toBe(
      rotated.keyId,
    );
    expect(rotated.keyId).not.toBe(oldKeyId);
  });

  it('does not take an approval for a different change', async () => {
    await lockedProject();
    await release110(generateTestKey(), ['0000000000000000']);
    expect(await failure(update())).toMatchObject({
      code: 'TRUST_CHANGE_REQUIRES_APPROVAL',
    });
  });

  it('forgets history when the lock is deleted, and nothing else: the manifest still says who is trusted', async () => {
    await lockedProject();
    const rotated = generateTestKey();
    await release110(rotated);
    await rm(join(root, 'opm.lock.json'));
    // With no history there is nothing to compare, so the change of signer goes
    // unnoticed: that is what the lock's memory was for, and it is gone.
    const result = await update();
    expect(result.lock.packages.tool?.attestation?.signerIdentity).toBe(
      rotated.keyId,
    );
    // The anchor is not in the lock. A key the manifest does not name is
    // refused with the lock or without it.
    await rm(join(root, 'opm.lock.json'));
    key = generateTestKey();
    newWorld();
    publish(['1.0.0', '1.1.0']);
    expect(await failure(update())).toMatchObject({
      code: 'SIGNATURE_VERIFICATION_FAILED',
    });
  });
});

describe('a lock that cannot be read', () => {
  it.skipIf(process.platform === 'win32')(
    'is no history, and does not stop the project from being synced',
    async () => {
      await initProject({ root, name: 'demo' });
      await writeFile(join(root, 'elsewhere.json'), '{}');
      await rm(join(root, 'opm.lock.json'), { force: true });
      // A symlink where the lock should be is refused by the lock reader. The
      // lock is about to be rewritten, and it was never allowed to block that.
      await symlink('elsewhere.json', join(root, 'opm.lock.json'));
      const result = await syncProject({ root, offline: true });
      expect(result.lock.packages).toEqual({});
      expect((await lstat(join(root, 'opm.lock.json'))).isSymbolicLink()).toBe(
        false,
      );
    },
  );
});

describe('naming a packslip tool on the command line', () => {
  it.each([
    [
      'packslip:github.com/jdx/hk',
      { alias: 'hk', purl: 'pkg:packslip/github.com/jdx/hk' },
    ],
    [
      'packslip:github.com/jdx/hk@2.5.0',
      {
        alias: 'hk',
        purl: 'pkg:packslip/github.com/jdx/hk@2.5.0',
        version: '2.5.0',
      },
    ],
    [
      'packslip:jdx/hk@2.5.0',
      {
        alias: 'hk',
        purl: 'pkg:packslip/github.com/jdx/hk@2.5.0',
        version: '2.5.0',
      },
    ],
    [
      'packslip:mise.jdx.dev',
      { alias: 'mise', purl: 'pkg:packslip/mise.jdx.dev' },
    ],
    [
      'pkg:packslip/github.com/jdx/hk@2.5.0',
      {
        alias: 'hk',
        purl: 'pkg:packslip/github.com/jdx/hk@2.5.0',
        version: '2.5.0',
      },
    ],
  ])('reads %s', (spec, expected) => {
    expect(parsePackageSpec(spec)).toMatchObject({
      ...expected,
      ecosystem: 'packslip',
    });
  });

  it('lets the user choose the alias', () => {
    expect(
      parsePackageSpec('packslip:jdx/hk', { alias: 'formatter' }).alias,
    ).toBe('formatter');
  });

  it.each([
    ['nothing after the scheme', 'packslip:'],
    ['a URL', 'packslip:https://github.com/jdx/hk'],
    ['an empty path segment', 'packslip:github.com//hk'],
    ['a path that climbs', 'packslip:github.com/../hk'],
    ['an empty version', 'packslip:jdx/hk@'],
    ['characters a project name cannot have', 'packslip:github.com/jdx/h k'],
    // Shorthand is exactly owner/repo: these name no GitHub project.
    ['a bare word', 'packslip:mise'],
    ['shorthand with three segments', 'packslip:a/b/c'],
  ])('refuses %s', (_label, spec) => {
    expect(() => parsePackageSpec(spec)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPEC' }),
    );
  });

  it('refuses to be told it is another ecosystem', () => {
    expect(() =>
      parsePackageSpec('packslip:jdx/hk', { ecosystem: 'npm' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPEC' }));
  });
});
